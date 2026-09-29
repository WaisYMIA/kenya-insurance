import { connect as tlsConnect } from "node:tls";
import { connect as netConnect, type Socket } from "node:net";
import { config } from "../config.ts";

/** Minimal dependency-free SMTP client (implicit TLS on 465 by default; SMTP_SECURE=false for plain, e.g. local relay). */
export async function smtpSend(opts: { to: string; subject: string; body: string }): Promise<void> {
  const { host, port, secure, user, pass, from } = config.smtp;
  const socket: Socket = secure ? tlsConnect({ host, port, servername: host }) : netConnect({ host, port });
  socket.setTimeout(10000);
  let buf = "";
  const waiters: Array<(r: { code: number; text: string }) => void> = [];
  socket.on("data", (d) => {
    buf += d.toString("utf8");
    let m;
    while ((m = buf.match(/^(?:\d{3}-.*\r?\n)*\d{3} .*\r?\n/))) {
      const block = m[0]; buf = buf.slice(block.length);
      waiters.shift()?.({ code: Number(block.slice(0, 3)), text: block });
    }
  });
  const reply = (expect: number[]) => new Promise<void>((resolve, reject) => {
    socket.once("timeout", () => reject(new Error("SMTP timeout")));
    socket.once("error", reject);
    waiters.push((r) => (expect.includes(r.code) ? resolve() : reject(new Error(`SMTP ${r.code}: ${r.text.trim()}`))));
  });
  const cmd = async (line: string, expect: number[]) => { const p = reply(expect); socket.write(line + "\r\n"); await p; };
  const b64 = (s: string) => Buffer.from(s).toString("base64");
  const clean = (s: string) => s.replace(/[\r\n]+/g, " ");

  try {
    await reply([220]);
    await cmd(`EHLO bimahub.local`, [250]);
    if (user) { await cmd("AUTH LOGIN", [334]); await cmd(b64(user), [334]); await cmd(b64(pass), [235]); }
    await cmd(`MAIL FROM:<${from}>`, [250]);
    await cmd(`RCPT TO:<${opts.to}>`, [250, 251]);
    await cmd("DATA", [354]);
    const msg = [`From: ${from}`, `To: ${opts.to}`, `Subject: ${clean(opts.subject)}`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "", opts.body.replace(/^\./gm, "..")].join("\r\n");
    await cmd(msg + "\r\n.", [250]);
    await cmd("QUIT", [221]).catch(() => {});
  } finally { socket.destroy(); }
}
