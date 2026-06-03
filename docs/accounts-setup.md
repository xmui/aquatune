# Aquatune accounts — Firebase setup

The account system (`src/accounts.js`) stores custom username/password accounts in
the Realtime Database and optionally links Google. A few **one-time, console-side**
steps are required; the app keeps working anonymously without them.

## 1. Deploy the database rules
`database.rules.json` keeps every existing path open (rooms, chat, portfolios,
market, leaderboard — unchanged behaviour) and adds protection to the new account
paths:

- `usernames/{usernameLower}` and `googleUsers/{uid}` are **claim-once** (can be
  created, can't be overwritten by another account) — prevents username/Google
  hijacking and races. Username uniqueness is enforced here.
- `accounts/{id}` is readable/writable (the trust model below); renaming claims
  the new name in the `usernames` index and leaves the old one pointing at you.

Deploy with the Firebase CLI:

```bash
firebase deploy --only database
```

> These rules intentionally leave `accounts/*` world-readable, because password
> verification happens on the client (hashes + salts are read to compare). This is
> a **trust model, not real security** — fine for a game, not for anything
> sensitive. For real protection, move verification to a Cloud Function.

## 2. Enable Google sign-in (optional feature)
For the "Log in with Google" / "Connect Google" buttons to work:

1. Firebase console → **Authentication → Sign-in method** → enable **Google**.
2. Firebase console → **Authentication → Settings → Authorized domains** → add the
   deployed host(s): `aquatune.netlify.app` (and `localhost` for dev).

Without these, anonymous + username/password accounts still work; only the Google
buttons will error.

## 3. Make yourself an admin (for password resets)
Forgot-password is admin-driven (no email). To get the **Admin: password resets**
panel in Settings → Aquatune Account:

1. Create/log into your account in the app.
2. In the Firebase console → Realtime Database, find your record under
   `accounts/{yourId}` and set `admin: true`.
3. Reload — the admin panel appears. It lists pending `passwordResets` and lets you
   set a temporary password for any username (the user is forced to change it on
   next login).
