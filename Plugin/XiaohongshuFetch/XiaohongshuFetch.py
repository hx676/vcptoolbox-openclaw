#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
XiaohongshuFetch

Supports:
- note detail URLs
- author profile URLs
- optional expansion of recent profile notes
"""

import json
import logging
import os
import re
import sys
import time
from urllib.parse import urlencode

import requests


PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(PLUGIN_DIR, "config.env")

if os.path.exists(CONFIG_PATH):
    with open(CONFIG_PATH, "r", encoding="utf-8") as config_file:
        for raw_line in config_file:
            line = raw_line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                os.environ.setdefault(key.strip(), value.strip())


class UTF8StreamHandler(logging.StreamHandler):
    def emit(self, record):
        try:
            msg = self.format(record)
            stream = self.stream
            if hasattr(stream, "buffer"):
                stream.buffer.write((msg + self.terminator).encode("utf-8"))
                stream.buffer.flush()
            else:
                stream.write(msg + self.terminator)
                self.flush()
        except Exception:
            self.handleError(record)


handler = UTF8StreamHandler(sys.stderr)
handler.setFormatter(logging.Formatter("%(asctime)s - %(levelname)s - %(message)s"))
logging.getLogger().addHandler(handler)
logging.getLogger().setLevel(logging.INFO)


TIMEOUT = int(os.environ.get("REQUEST_TIMEOUT", 20))

BASE_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
    "Origin": "https://www.xiaohongshu.com",
    "Referer": "https://www.xiaohongshu.com/",
    "Connection": "keep-alive",
}


def normalize_text(value):
    if value is None:
        return ""
    return str(value).replace("\r\n", "\n").strip()


def parse_bool(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "y", "on"}
    return False


def clamp_int(value, default, minimum, maximum):
    try:
        parsed = int(str(value).strip())
    except (TypeError, ValueError, AttributeError):
        return default
    return max(minimum, min(maximum, parsed))


def clamp_positive_int(value, default=10, minimum=1, maximum=20):
    return clamp_int(value, default, minimum, maximum)


def extract_note_id(url):
    for pattern in (
        r"/(?:discovery/item|explore)/([a-f0-9]{24})",
        r"/(?:discovery/item|explore)/([a-f0-9]+)",
        r"[?&]source_note_id=([a-f0-9]+)",
    ):
        match = re.search(pattern, url)
        if match:
            return match.group(1)
    return None


def extract_profile_id(url):
    match = re.search(r"/user/profile/([^/?#]+)", url)
    if match:
        return match.group(1)
    return None


def extract_xsec_token(url):
    match = re.search(r"[?&]xsec_token=([^&]+)", url)
    if match:
        return match.group(1)
    return ""


def resolve_short_url(url):
    if "xhslink.com" not in url:
        return url
    try:
        response = requests.get(
            url,
            allow_redirects=True,
            timeout=TIMEOUT,
            headers={"User-Agent": BASE_HEADERS["User-Agent"]},
        )
        logging.info("短链解析: %s -> %s", url, response.url)
        return response.url
    except Exception as exc:
        logging.error("短链解析失败: %s", exc)
        return url


def build_cookies_dict(a1, web_session, web_id):
    full_cookie = os.environ.get("XHS_COOKIE_FULL", "").strip()
    if full_cookie:
        cookies = {}
        for part in full_cookie.split(";"):
            part = part.strip()
            if "=" in part:
                key, value = part.split("=", 1)
                cookies[key.strip()] = value.strip()
        return cookies

    cookies = {}
    if a1:
        cookies["a1"] = a1
    if web_session:
        cookies["web_session"] = web_session
    if web_id:
        cookies["webId"] = web_id
    return cookies


def bracket_balance_extract(html, marker):
    index = html.find(marker)
    if index < 0:
        return None

    brace_start = html.find("{", index)
    if brace_start < 0:
        return None

    depth = 0
    in_string = False
    cursor = brace_start
    limit = min(brace_start + 500000, len(html))

    while cursor < limit:
        char = html[cursor]
        if in_string:
            if char == "\\":
                cursor += 2
                continue
            if char == '"':
                in_string = False
        else:
            if char == '"':
                in_string = True
            elif char == "{":
                depth += 1
            elif char == "}":
                depth -= 1
                if depth == 0:
                    raw_json = html[brace_start:cursor + 1]
                    raw_json = re.sub(r"\bundefined\b", "null", raw_json)
                    try:
                        state = json.loads(raw_json)
                        logging.info("bracket-balance OK, len=%d", len(raw_json))
                        return state
                    except json.JSONDecodeError as exc:
                        logging.error("JSON parse fail: %s", str(exc)[:100])
                        return None
        cursor += 1

    logging.error("bracket-balance: 未找到匹配闭合括号")
    return None


def fetch_html(url, cookies_dict):
    headers = dict(BASE_HEADERS)
    headers["Accept"] = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    headers["Upgrade-Insecure-Requests"] = "1"
    headers["Sec-Fetch-Dest"] = "document"
    headers["Sec-Fetch-Mode"] = "navigate"
    headers["Sec-Fetch-Site"] = "none"

    cookie_str = "; ".join(f"{key}={value}" for key, value in cookies_dict.items())
    if cookie_str:
        headers["Cookie"] = cookie_str

    try:
        response = requests.get(url, headers=headers, timeout=TIMEOUT, allow_redirects=True)
        response.raise_for_status()
        logging.info("HTML GET %s -> %d, len=%d", url, response.status_code, len(response.text))
        return response.text
    except Exception as exc:
        logging.error("HTML 请求失败 %s: %s", url, exc)
        return None


def build_browser_options(input_data):
    enabled_value = input_data.get(
        "use_browser",
        input_data.get(
            "useBrowser",
            os.environ.get("XHS_PROFILE_USE_BROWSER", "0"),
        ),
    )
    channel = normalize_text(
        input_data.get(
            "browser_channel",
            input_data.get("browserChannel", os.environ.get("XHS_BROWSER_CHANNEL", "chrome")),
        )
    ) or "chrome"
    user_data_dir = normalize_text(
        input_data.get(
            "browser_user_data_dir",
            input_data.get(
                "browserUserDataDir",
                os.environ.get(
                    "XHS_BROWSER_USER_DATA_DIR",
                    os.path.join(PLUGIN_DIR, "browser_profile"),
                ),
            ),
        )
    ) or os.path.join(PLUGIN_DIR, "browser_profile")
    return {
        "enabled": parse_bool(enabled_value),
        "headless": parse_bool(
            input_data.get(
                "browser_headless",
                input_data.get("browserHeadless", os.environ.get("XHS_BROWSER_HEADLESS", "0")),
            )
        ),
        "timeout_ms": clamp_int(
            input_data.get(
                "browser_timeout_ms",
                input_data.get(
                    "browserTimeoutMs",
                    os.environ.get("XHS_BROWSER_TIMEOUT_MS", 180000),
                ),
            ),
            default=180000,
            minimum=30000,
            maximum=600000,
        ),
        "channel": channel,
        "user_data_dir": user_data_dir,
    }


def build_playwright_cookies(cookies_dict):
    cookies = []
    for name, value in cookies_dict.items():
        value = normalize_text(value)
        if not value:
            continue
        cookies.append(
            {
                "name": name,
                "value": value,
                "domain": ".xiaohongshu.com",
                "path": "/",
                "httpOnly": False,
                "secure": True,
                "sameSite": "Lax",
            }
        )
    return cookies


def is_browser_verification_page(page_url, page_title, body_text):
    combined = "\n".join(
        [
            normalize_text(page_url),
            normalize_text(page_title),
            normalize_text(body_text),
        ]
    )
    markers = (
        "website-login/captcha",
        "安全验证",
        "扫码验证身份",
        "二维码1分钟失效",
        "小红书APP",
        "问题反馈",
    )
    return any(marker in combined for marker in markers)


def parse_state_from_html(html):
    state = bracket_balance_extract(html, "window.__INITIAL_STATE__")
    if state:
        return state

    fallback_match = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.DOTALL)
    if fallback_match:
        try:
            state = json.loads(fallback_match.group(1))
            logging.info("NEXT_DATA fallback OK")
            return state
        except json.JSONDecodeError:
            return None
    return None


def build_note_url(note_id, xsec_token="", xsec_source="pc_user"):
    base_url = f"https://www.xiaohongshu.com/explore/{note_id}"
    params = {}
    if xsec_token:
        params["xsec_token"] = xsec_token
    if xsec_source:
        params["xsec_source"] = xsec_source
    return base_url + ("?" + urlencode(params) if params else "")


def build_profile_url(profile_id):
    return f"https://www.xiaohongshu.com/user/profile/{profile_id}"


def extract_note_from_state(state, note_id):
    note = None
    note_map = (state.get("note") or {}).get("noteDetailMap", {})
    if note_id in note_map:
        note = note_map[note_id].get("note", note_map[note_id])

    if not note and note_map:
        first_key = list(note_map.keys())[0]
        first_value = note_map[first_key]
        if isinstance(first_value, dict):
            note = first_value.get("note", first_value)
            logging.info("NDM fallback: key=%s", first_key)

    if not note:
        for key in ("noteDetail", "detail"):
            candidate = state.get(key)
            if candidate:
                note = candidate
                break

    return note


def extract_image_url(image_obj, preferred_scene="WB_DFT"):
    if not isinstance(image_obj, dict):
        return ""

    info_list = image_obj.get("info_list") or image_obj.get("infoList") or []
    if isinstance(info_list, list):
        for info in info_list:
            scene = info.get("image_scene") or info.get("imageScene")
            if preferred_scene and scene == preferred_scene and info.get("url"):
                return info["url"].split("?")[0]
        for info in info_list:
            if info.get("url"):
                return info["url"].split("?")[0]

    for key in ("urlDefault", "url_default", "url"):
        value = image_obj.get(key)
        if value:
            return str(value).split("?")[0]

    return ""


def format_note(note, note_id):
    title = normalize_text(
        note.get("display_title") or note.get("title") or note.get("desc") or note.get("description")
    )
    desc = normalize_text(note.get("desc") or note.get("description") or note.get("note_text"))

    if not title:
        title = desc[:30] + ("…" if len(desc) > 30 else "")

    note_type = note.get("type", "normal")
    user = note.get("user") or note.get("author") or {}
    author = normalize_text(user.get("nickname") or user.get("nick_name")) or "未知作者"
    author_id = normalize_text(user.get("user_id") or user.get("userId") or user.get("userid"))

    interact = note.get("interact_info") or note.get("interactInfo") or {}
    likes = str(interact.get("liked_count") or interact.get("likedCount") or "0")
    collects = str(
        interact.get("collected_count")
        or interact.get("collectedCount")
        or interact.get("collect_count")
        or "0"
    )
    comments = str(interact.get("comment_count") or interact.get("commentCount") or "0")

    lines = [
        "### 📕 " + (title or "（无标题）"),
        f"**作者**: {author}（ID: {author_id or '未知'}）",
        f"**互动**: ❤️ {likes} ⭐ {collects} 💬 {comments}",
        "",
        "**正文**:",
        desc or "（正文为空）",
        "",
    ]

    if note_type == "video":
        video = note.get("video") or {}
        video_url = ""
        try:
            h264_list = (((video.get("media") or {}).get("stream") or {}).get("h264")) or []
            if h264_list:
                video_url = h264_list[0].get("masterUrl") or h264_list[0].get("master_url") or ""
        except Exception:
            video_url = ""
        if not video_url:
            video_url = (
                ((video.get("consumer") or {}).get("originVideoKey"))
                or video.get("url")
                or ""
            )

        if video_url:
            lines.extend(
                [
                    "#### 🎀 无水印视频",
                    f'<video src="{video_url}" controls style="max-width:100%;border-radius:8px;"></video>',
                    "",
                    f"[视频直链]({video_url})",
                    "",
                ]
            )
        else:
            lines.append("⚠️ 视频直链获取失败，请尝试更新 Cookie。")

    image_list = note.get("imageList") or note.get("image_list") or note.get("images") or []
    if image_list:
        lines.append(f"#### 🖼️ 无水印图片（共 {len(image_list)} 张）:")
        for index, image_obj in enumerate(image_list, 1):
            image_url = extract_image_url(image_obj, preferred_scene="WB_DFT")
            if image_url:
                lines.append(
                    f'<img src="{image_url}" alt="图片{index}" '
                    'style="max-width:100%;margin:4px 0;border-radius:8px;">'
                )
        lines.append("")

    tag_list = note.get("tagList") or note.get("tag_list") or note.get("tags") or []
    if tag_list:
        tags = []
        for tag in tag_list:
            if isinstance(tag, dict):
                name = normalize_text(tag.get("name") or tag.get("tag"))
            else:
                name = normalize_text(tag)
            if name:
                tags.append("#" + name.lstrip("#"))
        if tags:
            lines.append("**标签**: " + " ".join(tags))
            lines.append("")

    lines.append("---")
    lines.append(f"*数据来源：小红书 | 笔记ID: {note_id}*")
    return "\n".join(lines)


def fetch_note_data(note_id, cookies_dict, original_url=None, xsec_token=""):
    def build_candidate(url_base):
        params = {"xsec_source": "pc_feed"}
        if xsec_token:
            params["xsec_token"] = xsec_token
        return url_base + "?" + urlencode(params)

    candidate_urls = []
    if original_url:
        query_index = original_url.find("?")
        base = original_url[:query_index] if query_index >= 0 else original_url
        candidate_urls.append(build_candidate(base))
    candidate_urls.append(build_candidate(f"https://www.xiaohongshu.com/discovery/item/{note_id}"))

    unique_urls = []
    seen = set()
    for candidate in candidate_urls:
        if candidate not in seen:
            seen.add(candidate)
            unique_urls.append(candidate)

    for url in unique_urls:
        logging.info("尝试: %s", url)
        html = fetch_html(url, cookies_dict)
        if not html:
            continue

        state = parse_state_from_html(html)
        if not state:
            logging.warning("state 解析失败: %s", url)
            continue

        note = extract_note_from_state(state, note_id)
        if note:
            return {
                "note": note,
                "state": state,
                "note_text": format_note(note, note_id),
                "resolved_url": url,
            }

        logging.warning("state 中未找到笔记数据: %s", url)

    return None


def fetch_note(note_id, cookies_dict, original_url=None, xsec_token=""):
    result = fetch_note_data(
        note_id,
        cookies_dict,
        original_url=original_url,
        xsec_token=xsec_token,
    )
    if result:
        return result["note_text"]
    return "❌ 未能在页面数据中定位笔记，请确认链接有效或更新 Cookie。"


def normalize_interactions(interactions):
    result = {"follows": "0", "fans": "0", "interaction": "0"}
    if not isinstance(interactions, list):
        return result

    for item in interactions:
        if not isinstance(item, dict):
            continue
        interaction_type = item.get("type")
        count = str(item.get("count") or "0")
        if interaction_type in result:
            result[interaction_type] = count
            continue

        name = normalize_text(item.get("name"))
        if name == "获赞与收藏":
            result["interaction"] = count
    return result


def select_profile_note_group(notes_groups, active_tab):
    if not isinstance(notes_groups, list):
        return []

    candidate_indices = []
    if isinstance(active_tab, dict):
        for key in ("index", "key"):
            value = active_tab.get(key)
            if isinstance(value, int) and 0 <= value < len(notes_groups):
                candidate_indices.append(value)

    for index in range(len(notes_groups)):
        if index not in candidate_indices:
            candidate_indices.append(index)

    for index in candidate_indices:
        group = notes_groups[index]
        if isinstance(group, list) and group:
            return group
    return []


def extract_profile_from_state(state, profile_id):
    user_state = state.get("user") or {}
    user_info = user_state.get("userInfo") or {}
    page_data = user_state.get("userPageData") or {}
    basic_info = page_data.get("basicInfo") or {}
    interactions = normalize_interactions(page_data.get("interactions") or [])
    active_tab = user_state.get("activeTab") or {}
    note_group = select_profile_note_group(user_state.get("notes") or [], active_tab)

    notes = []
    for item in note_group:
        if not isinstance(item, dict):
            continue

        note_card = item.get("noteCard") or item
        if not isinstance(note_card, dict):
            continue

        note_id = normalize_text(note_card.get("noteId") or item.get("id") or note_card.get("id"))
        if not note_id:
            continue

        xsec_token = normalize_text(note_card.get("xsecToken") or note_card.get("xsec_token"))
        title = normalize_text(note_card.get("displayTitle") or note_card.get("title")) or "（无标题）"
        note_type = normalize_text(note_card.get("type")) or "normal"
        interact_info = note_card.get("interactInfo") or note_card.get("interact_info") or {}
        likes = str(interact_info.get("likedCount") or interact_info.get("liked_count") or "0")
        cover_url = extract_image_url(note_card.get("cover") or {}, preferred_scene="WB_DFT")

        notes.append(
            {
                "note_id": note_id,
                "title": title,
                "type": note_type,
                "likes": likes,
                "xsec_token": xsec_token,
                "cover_url": cover_url,
                "detail_url": build_note_url(note_id, xsec_token=xsec_token, xsec_source="pc_user"),
            }
        )

    profile = {
        "profile_id": normalize_text(
            user_info.get("userId") or basic_info.get("userId") or profile_id
        ),
        "nickname": normalize_text(
            basic_info.get("nickname") or user_info.get("nickname") or user_info.get("nickName")
        )
        or "未知作者",
        "red_id": normalize_text(basic_info.get("redId") or user_info.get("redId")),
        "desc": normalize_text(basic_info.get("desc") or user_info.get("desc")),
        "ip_location": normalize_text(basic_info.get("ipLocation") or user_info.get("ipLocation")),
        "avatar_url": normalize_text(
            basic_info.get("imageb") or basic_info.get("images") or user_info.get("avatar")
        ),
        "gender": basic_info.get("gender"),
        "active_tab_label": normalize_text(active_tab.get("label")) or "笔记",
        "interactions": interactions,
        "notes": notes,
    }

    if profile["nickname"] == "未知作者" and not notes and not profile["desc"]:
        return None
    return profile


def format_profile(profile, cookies_dict, max_notes=10, include_note_details=False):
    notes = profile.get("notes", [])[:max_notes]
    follows = profile.get("interactions", {}).get("follows", "0")
    fans = profile.get("interactions", {}).get("fans", "0")
    likes_and_collects = profile.get("interactions", {}).get("interaction", "0")

    lines = [
        "### 👤 " + profile.get("nickname", "未知作者") + " 的主页",
        f"**作者ID**: {profile.get('profile_id') or '未知'}",
    ]

    if profile.get("red_id"):
        lines.append(f"**小红书号**: {profile['red_id']}")
    if profile.get("ip_location"):
        lines.append(f"**地区**: {profile['ip_location']}")
    lines.append(f"**主页数据**: 关注 {follows} | 粉丝 {fans} | 获赞与收藏 {likes_and_collects}")

    if profile.get("avatar_url"):
        lines.append(
            f'<img src="{profile["avatar_url"]}" alt="{profile.get("nickname", "头像")}" '
            'style="width:96px;height:96px;border-radius:50%;object-fit:cover;">'
        )

    if profile.get("desc"):
        lines.extend(["", "**简介**:", profile["desc"]])

    lines.append("")
    lines.append(f"#### 最近 {len(notes)} 条{profile.get('active_tab_label', '笔记')}:")

    if not notes:
        lines.append("未在主页中解析到最近笔记列表。")
    else:
        for index, note in enumerate(notes, 1):
            note_type = "视频" if note.get("type") == "video" else "图文"
            lines.append(f"{index}. {note.get('title') or '（无标题）'}")
            lines.append(
                f"   类型: {note_type} | 点赞: {note.get('likes', '0')} | 笔记ID: {note.get('note_id')}"
            )
            lines.append(f"   链接: {note.get('detail_url')}")
            if note.get("cover_url"):
                lines.append(
                    f'   <img src="{note["cover_url"]}" alt="封面{index}" '
                    'style="max-width:280px;margin:4px 0;border-radius:8px;">'
                )

    if include_note_details and notes:
        lines.append("")
        lines.append("#### 主页笔记详情:")
        for index, note in enumerate(notes, 1):
            lines.append("")
            lines.append(f"##### {index}. {note.get('title') or '（无标题）'}")
            detail_text = fetch_note(
                note["note_id"],
                cookies_dict,
                original_url=note.get("detail_url"),
                xsec_token=note.get("xsec_token", ""),
            )
            lines.append(detail_text)

    lines.append("")
    lines.append("---")
    lines.append(f"*数据来源：小红书主页 | 作者ID: {profile.get('profile_id') or '未知'}*")
    return "\n".join(lines)


def fetch_profile_via_browser(
    profile_id,
    cookies_dict,
    original_url=None,
    max_notes=10,
    include_note_details=False,
    browser_options=None,
):
    browser_options = browser_options or {}
    try:
        from playwright.sync_api import Error as PlaywrightError
        from playwright.sync_api import sync_playwright
    except ImportError:
        return "❌ 当前环境未安装 Playwright，无法启用浏览器模式抓作者主页。"

    timeout_ms = int(browser_options.get("timeout_ms") or 180000)
    headless = bool(browser_options.get("headless"))
    channel = normalize_text(browser_options.get("channel")) or "chrome"
    user_data_dir = normalize_text(browser_options.get("user_data_dir")) or os.path.join(
        PLUGIN_DIR, "browser_profile"
    )
    os.makedirs(user_data_dir, exist_ok=True)

    target_url = (original_url.split("?", 1)[0] if original_url else "") or build_profile_url(profile_id)

    try:
        with sync_playwright() as playwright:
            context = playwright.chromium.launch_persistent_context(
                user_data_dir=user_data_dir,
                channel=channel,
                headless=headless,
                locale="zh-CN",
                viewport={"width": 1440, "height": 960},
            )
            try:
                context.set_default_timeout(timeout_ms)
                playwright_cookies = build_playwright_cookies(cookies_dict)
                if playwright_cookies:
                    context.add_cookies(playwright_cookies)

                page = context.pages[0] if context.pages else context.new_page()
                page.goto(target_url, wait_until="domcontentloaded", timeout=timeout_ms)
                logging.info("浏览器模式已打开: %s", page.url)

                deadline = time.time() + timeout_ms / 1000.0
                verification_logged = False
                while time.time() < deadline:
                    try:
                        page.wait_for_load_state("networkidle", timeout=3000)
                    except Exception:
                        pass

                    state = page.evaluate("() => window.__INITIAL_STATE__ || null")
                    if isinstance(state, dict):
                        profile = extract_profile_from_state(state, profile_id)
                        if profile:
                            logging.info("浏览器模式抓到主页数据: %s", profile.get("profile_id"))
                            return format_profile(
                                profile,
                                cookies_dict=cookies_dict,
                                max_notes=max_notes,
                                include_note_details=include_note_details,
                            )

                    page_title = page.title()
                    try:
                        body_text = page.locator("body").inner_text(timeout=1000)
                    except Exception:
                        body_text = ""

                    if is_browser_verification_page(page.url, page_title, body_text):
                        if headless:
                            return (
                                "❌ 浏览器模式遇到小红书安全验证，但当前是无头模式，无法扫码。"
                                "请把 browser_headless 设为 false 后重试。"
                            )
                        if not verification_logged:
                            logging.info("浏览器模式正在等待用户完成扫码/安全验证...")
                            verification_logged = True
                        try:
                            page.wait_for_timeout(2000)
                        except PlaywrightError as exc:
                            if "has been closed" in str(exc):
                                return "❌ 浏览器验证窗口已被关闭，主页抓取被中断。请重新触发一次，并在验证完成前不要关闭浏览器窗口。"
                            raise
                        continue

                    try:
                        page.wait_for_timeout(1500)
                    except PlaywrightError as exc:
                        if "has been closed" in str(exc):
                            return "❌ 浏览器窗口已被关闭，主页抓取被中断。请重新触发一次，并在抓取完成前不要关闭浏览器窗口。"
                        raise

                if verification_logged:
                    return (
                        "❌ 浏览器已打开作者主页验证页，但在设定时间内没有完成扫码/验证。"
                        "请完成验证后重试，或把 browser_timeout_ms 调大一些。"
                    )
                return "❌ 浏览器模式已打开主页，但仍未拿到作者数据，请确认浏览器里该主页能正常显示。"
            finally:
                context.close()
    except PlaywrightError as exc:
        logging.error("浏览器模式失败: %s", exc)
        return f"❌ 浏览器模式启动失败: {exc}"


def fetch_profile(
    profile_id,
    cookies_dict,
    original_url=None,
    max_notes=10,
    include_note_details=False,
    browser_options=None,
):
    candidate_urls = []
    if original_url:
        base_url = original_url.split("?", 1)[0]
        candidate_urls.append(base_url)
    candidate_urls.append(build_profile_url(profile_id))

    unique_urls = []
    seen = set()
    for candidate in candidate_urls:
        if candidate not in seen:
            seen.add(candidate)
            unique_urls.append(candidate)

    for url in unique_urls:
        logging.info("尝试主页: %s", url)
        html = fetch_html(url, cookies_dict)
        if not html:
            continue

        state = parse_state_from_html(html)
        if not state:
            if "fe-login" in html and len(html) < 30000:
                if browser_options and browser_options.get("enabled"):
                    logging.info("主页返回登录/验证壳页，切换浏览器持久会话模式")
                    return fetch_profile_via_browser(
                        profile_id,
                        cookies_dict,
                        original_url=original_url,
                        max_notes=max_notes,
                        include_note_details=include_note_details,
                        browser_options=browser_options,
                    )
                return (
                    "❌ 当前作者主页返回的是登录/验证壳页。"
                    "现有 Cookie 还能抓单篇笔记，但不足以直接打开作者主页。"
                    "如需抓主页，请改用完整浏览器 Cookie，或启用浏览器模式并先在浏览器里通过小红书安全验证。"
                )
            logging.warning("主页 state 解析失败: %s", url)
            continue

        profile = extract_profile_from_state(state, profile_id)
        if profile:
            return format_profile(
                profile,
                cookies_dict=cookies_dict,
                max_notes=max_notes,
                include_note_details=include_note_details,
            )

        logging.warning("主页 state 中未找到作者信息: %s", url)

    if browser_options and browser_options.get("enabled"):
        logging.info("普通请求模式未拿到主页数据，切换浏览器持久会话模式")
        return fetch_profile_via_browser(
            profile_id,
            cookies_dict,
            original_url=original_url,
            max_notes=max_notes,
            include_note_details=include_note_details,
            browser_options=browser_options,
        )

    return "❌ 未能在主页中定位作者信息，请确认主页链接有效或更新 Cookie。"


def main():
    output = {}
    try:
        raw_input = sys.stdin.read()
        if not raw_input.strip():
            raise ValueError("没有接收到标准输入数据")

        input_data = json.loads(raw_input)
        raw_url = normalize_text(input_data.get("url"))
        if not raw_url:
            raise ValueError("缺少必需参数: url")

        a1 = os.environ.get("XHS_COOKIE_A1", "") or input_data.get("a1", "")
        web_session = os.environ.get("XHS_COOKIE_WEB_SESSION", "") or input_data.get("web_session", "")
        web_id = os.environ.get("XHS_COOKIE_WEB_ID", "") or input_data.get("web_id", "")

        max_notes = clamp_positive_int(
            input_data.get("max_notes", input_data.get("maxNotes", 10)),
            default=10,
            minimum=1,
            maximum=20,
        )
        include_note_details = parse_bool(
            input_data.get("include_note_details", input_data.get("includeNoteDetails", False))
        )
        include_author_recent_notes = parse_bool(
            input_data.get(
                "include_author_recent_notes",
                input_data.get("includeAuthorRecentNotes", False),
            )
        )
        author_recent_notes_only = parse_bool(
            input_data.get(
                "author_recent_notes_only",
                input_data.get("authorRecentNotesOnly", False),
            )
        )
        browser_options = build_browser_options(input_data)

        logging.info("原始 URL: %s", raw_url)
        logging.info(
            "Cookie a1:%s web_session:%s webId:%s",
            "已配置" if a1 else "未配置",
            "已配置" if web_session else "未配置",
            "已配置" if web_id else "未配置",
        )
        logging.info(
            "browser enabled=%s headless=%s timeout_ms=%s channel=%s",
            browser_options.get("enabled"),
            browser_options.get("headless"),
            browser_options.get("timeout_ms"),
            browser_options.get("channel"),
        )

        cookies_dict = build_cookies_dict(a1, web_session, web_id)
        resolved_url = resolve_short_url(raw_url)
        note_id = extract_note_id(resolved_url)
        profile_id = extract_profile_id(resolved_url)

        if note_id:
            xsec_token = extract_xsec_token(resolved_url)
            logging.info("笔记 ID: %s", note_id)
            logging.info(
                "xsec_token: %s",
                xsec_token[:20] + "..." if len(xsec_token) > 20 else xsec_token,
            )
            note_result = fetch_note_data(
                note_id,
                cookies_dict,
                original_url=resolved_url,
                xsec_token=xsec_token,
            )
            if note_result:
                sections = []
                note_author = ((note_result.get("note") or {}).get("user") or {})
                note_author_id = normalize_text(
                    note_author.get("userId") or note_author.get("user_id") or note_author.get("userid")
                )
                if not author_recent_notes_only:
                    sections.append(note_result["note_text"])

                if include_author_recent_notes or author_recent_notes_only:
                    profile = extract_profile_from_state(note_result["state"], profile_id="")
                    if profile and profile.get("profile_id") == note_author_id:
                        profile_text = format_profile(
                            profile,
                            cookies_dict=cookies_dict,
                            max_notes=max_notes,
                            include_note_details=include_note_details,
                        )
                        sections.append(profile_text)
                    else:
                        sections.append("⚠️ 当前笔记页里没有返回当前作者的主页数据，无法直接从这条笔记反推出作者最近笔记。")

                result_text = "\n\n".join(section for section in sections if section)
            else:
                result_text = "❌ 未能在页面数据中定位笔记，请确认链接有效或更新 Cookie。"
        elif profile_id:
            logging.info("主页 ID: %s", profile_id)
            logging.info("max_notes=%s include_note_details=%s", max_notes, include_note_details)
            result_text = fetch_profile(
                profile_id,
                cookies_dict,
                original_url=resolved_url,
                max_notes=max_notes,
                include_note_details=include_note_details,
                browser_options=browser_options,
            )
        else:
            raise ValueError("无法从链接中识别为笔记页或作者主页: " + resolved_url)

        output = {"status": "success", "result": result_text}
    except Exception as exc:
        logging.error("主流程异常: %s", exc)
        output = {"status": "error", "error": str(exc)}

    sys.stdout.buffer.write(json.dumps(output, ensure_ascii=False).encode("utf-8"))
    sys.stdout.buffer.write(b"\n")
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    main()
