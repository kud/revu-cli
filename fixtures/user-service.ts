import { db } from "./db"
import { hashPassword, verifyPassword } from "./crypto"
import type { User, Session } from "./types"

const SESSION_TTL = 60 * 60 * 24 * 7 // 7 days in seconds

interface CreateUserInput {
  email: string
  password: string
  displayName?: string
}

export const createUser = async (input: CreateUserInput): Promise<User> => {
  const existing = await db.query.users.findFirst({
    where: (u, { eq }) => eq(u.email, input.email),
  })

  if (existing) throw new Error("Email already registered")

  const passwordHash = await hashPassword(input.password)

  return db
    .insert(schema.users)
    .values({
      email: input.email,
      passwordHash,
      displayName: input.displayName ?? input.email.split("@")[0],
    })
    .returning()
    .then((rows) => rows[0]!)
}

export const login = async (
  email: string,
  password: string,
): Promise<Session> => {
  const user = await db.query.users.findFirst({
    where: (u, { eq }) => eq(u.email, email),
  })

  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    // Constant-time check to avoid timing attacks
    throw new Error("Invalid credentials")
  }

  return db
    .insert(schema.sessions)
    .values({
      userId: user.id,
      expiresAt: new Date(Date.now() + SESSION_TTL * 1000),
    })
    .returning()
    .then((rows) => rows[0]!)
}

export const logout = async (sessionId: string): Promise<void> => {
  await db.delete(schema.sessions).where(eq(schema.sessions.id, sessionId))
}
