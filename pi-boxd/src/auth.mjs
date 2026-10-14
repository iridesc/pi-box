import { timingSafeEqual } from "node:crypto";

function safeEqual(actual, expected) {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** 校验一个 HTTP Basic Authorization header。未设置密码时表示认证关闭。 */
export function verifyBasicAuthorization(header, { username, password }) {
  if (!password) return true;
  if (typeof header !== "string" || !header.startsWith("Basic ")) return false;
  let decoded;
  try {
    decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  } catch {
    return false;
  }
  const separator = decoded.indexOf(":");
  if (separator < 0) return false;
  return safeEqual(decoded.slice(0, separator), username) && safeEqual(decoded.slice(separator + 1), password);
}

/** 在现有 Node HTTP server 最外层安装认证，覆盖静态资源、API 与 SSE。 */
export function installBasicAuth(server, options = {}) {
  const username = options.username ?? process.env.PI_BOX_AUTH_USERNAME ?? "pi";
  const password = options.password ?? process.env.PI_BOX_AUTH_PASSWORD ?? "";
  if (!password) return { enabled: false, username };

  const handlers = server.listeners("request");
  server.removeAllListeners("request");
  server.on("request", (req, res) => {
    if (!verifyBasicAuthorization(req.headers.authorization, { username, password })) {
      res.writeHead(401, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "WWW-Authenticate": 'Basic realm="pi-box", charset="UTF-8"',
      });
      res.end("需要身份认证");
      return;
    }
    for (const handler of handlers) handler.call(server, req, res);
  });
  return { enabled: true, username };
}
