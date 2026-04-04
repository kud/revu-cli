#!/usr/bin/env zsh
set -e

SCRIPT_DIR="${0:A:h}"
RECORD=false
UPLOAD=false
for arg in "$@"; do
  [[ "$arg" == "--record" ]] && RECORD=true
  [[ "$arg" == "--upload" ]] && UPLOAD=true
done

CAST_OUT="${SCRIPT_DIR}/../assets/demo.cast"

if $UPLOAD; then
  asciinema upload "$CAST_OUT"
  exit 0
fi

if $RECORD; then
  asciinema rec "$CAST_OUT" --overwrite --command "zsh $0"
  echo ""
  echo "Generating GIF…"
  agg "$CAST_OUT" "${SCRIPT_DIR}/../assets/demo.gif"
  echo "Written: assets/demo.gif"
  exit 0
fi

DIR=$(mktemp -d)
trap "rm -rf $DIR" EXIT

cd "$DIR"
git init -q
git config user.email "demo@revu.local"
git config user.name "Demo"

# --- initial commit ---

mkdir -p src

cat > src/auth.ts << 'EOF'
import { db } from "./db"
import { hashPassword } from "./crypto"

export const login = async (email: string, password: string) => {
  const user = await db.users.findOne({ email })
  if (!user) throw new Error("User not found")

  const valid = await hashPassword(password) === user.passwordHash
  if (!valid) throw new Error("Invalid password")

  return { id: user.id, email: user.email, role: user.role }
}

export const logout = async (sessionId: string) => {
  await db.sessions.delete(sessionId)
}
EOF

cat > src/db.ts << 'EOF'
import { createClient } from "postgres"

export const db = createClient({
  host: process.env.DB_HOST,
  port: 5432,
  database: "app",
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
})

export const migrate = async () => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      created_at TIMESTAMPTZ DEFAULT now()
    )
  `)
}
EOF

cat > src/api.ts << 'EOF'
import { login, logout } from "./auth"

export const routes = {
  "POST /login": async (req: Request) => {
    const { email, password } = await req.json()
    const user = await login(email, password)
    return Response.json(user)
  },

  "POST /logout": async (req: Request) => {
    const sessionId = req.headers.get("x-session-id") ?? ""
    await logout(sessionId)
    return new Response(null, { status: 204 })
  },
}
EOF

cat > README.md << 'EOF'
# app

A simple web app.

## Setup

```sh
npm install
npm run dev
```
EOF

git add -A
git commit -q -m "feat: initial commit"

# --- changes to review ---

cat > src/auth.ts << 'EOF'
import { db } from "./db"
import { hashPassword, verifyPassword } from "./crypto"
import { createSession } from "./session"

export const login = async (email: string, password: string) => {
  const user = await db.users.findOne({ email })
  if (!user) throw new Error("User not found")

  const valid = await verifyPassword(password, user.passwordHash)
  if (!valid) throw new Error("Invalid credentials")

  const session = await createSession(user.id)
  return { id: user.id, email: user.email, role: user.role, sessionId: session.id }
}

export const logout = async (sessionId: string) => {
  await db.sessions.delete(sessionId)
}

export const refreshSession = async (sessionId: string) => {
  const session = await db.sessions.findOne({ id: sessionId })
  if (!session || session.expiresAt < new Date()) throw new Error("Session expired")
  await db.sessions.update({ id: sessionId }, { expiresAt: new Date(Date.now() + 7 * 86400_000) })
}
EOF

cat > src/db.ts << 'EOF'
import { createClient } from "postgres"

export const db = createClient({
  host: process.env.DB_HOST ?? "localhost",
  port: Number(process.env.DB_PORT ?? 5432),
  database: process.env.DB_NAME ?? "app",
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
})

export const migrate = async () => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      created_at TIMESTAMPTZ DEFAULT now()
    )
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    )
  `)
}
EOF

rm README.md

cat > src/session.ts << 'EOF'
import { db } from "./db"

export const createSession = async (userId: string) => {
  const [session] = await db.query(
    `INSERT INTO sessions (user_id, expires_at)
     VALUES ($1, now() + interval '7 days')
     RETURNING *`,
    [userId],
  )
  return session
}
EOF

git add -A

REVU_BIN="$(dirname "$0")/../npm-packages/darwin-arm64/revu-bin"
if [[ ! -f "$REVU_BIN" ]]; then
  REVU_BIN="$(dirname "$0")/../revu-bin"
fi

exec "$REVU_BIN" 2>/dev/null
