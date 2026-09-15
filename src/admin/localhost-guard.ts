import type { Request, Response, NextFunction } from "express";

function isLocalAddress(ip: string | undefined): boolean {
  if (!ip) return false;
  const normalized = ip.replace(/^::ffff:/i, "").toLowerCase();
  if (normalized === "127.0.0.1" || normalized === "::1") return true;
  return false;
}

export function localhostOnly(req: Request, res: Response, next: NextFunction): void {
  const remote = req.socket.remoteAddress;
  if (!isLocalAddress(remote)) {
    res.status(403).json({ ok: false, error: "Admin API is localhost-only" });
    return;
  }
  next();
}

export function adminAuth(req: Request, res: Response, next: NextFunction): void {
  const token = process.env.ADMIN_TOKEN?.trim();
  if (!token) {
    next();
    return;
  }
  const header = req.headers.authorization;
  const provided = header?.startsWith("Bearer ") ? header.slice(7) : req.headers["x-admin-token"];
  if (provided !== token) {
    res.status(401).json({ ok: false, error: "Invalid admin token" });
    return;
  }
  next();
}
