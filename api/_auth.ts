import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import type { VercelRequest } from '@vercel/node'

const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret'

interface UserPayload {
  id: string
  username: string
  role: 'admin' | 'manager' | 'staff'
}

export function signToken(payload: UserPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '8h' })
}

export function verifyToken(token: string): UserPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as UserPayload
  } catch {
    return null
  }
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10)
}

export async function comparePassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash)
}

export function requireAuth(req: VercelRequest): UserPayload | null {
  const auth = req.headers.authorization
  if (auth?.startsWith('Bearer ')) {
    return verifyToken(auth.substring(7))
  }
  return null
}
