const http = require('http');

const postData = JSON.stringify({
  model: "gemma4:26b",
  messages: [{ role: "user", content: "Hello" }],
  stream: false
});

const options = {
  hostname: 'localhost',
  port: 11434,
  path: '/v1/chat/completions',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(postData)
  }
};

const req = http.request(options, (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => { console.log(data); });
});

req.on('error', (e) => { console.error(`problem with request: ${e.message}`); });
req.write(postData);
req.end();
