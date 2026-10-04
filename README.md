# DayTrack

A multi-user daily task tracker. Each user signs up, plans tasks (one-time or recurring), reviews them every night as **done** or **not completed**, and tracks progress with weekly, monthly and yearly analytics.

## Run locally

```bash
npm install
npm start
```

Open http://localhost:3000 and create an account. Locally, data is stored in the SQLite file `data/daytrack.db`.

| Env var              | Default            | Purpose                                                        |
|----------------------|--------------------|----------------------------------------------------------------|
| `PORT`               | `3000`             | HTTP port                                                      |
| `TURSO_DATABASE_URL` | –                  | Hosted Turso database (`libsql://...`). If unset, uses `DB_FILE` |
| `TURSO_AUTH_TOKEN`   | –                  | Auth token for the Turso database                              |
| `DB_FILE`            | `data/daytrack.db` | Local SQLite file, used when no Turso URL is set               |
| `NODE_ENV`           | –                  | `production` marks cookies `Secure` and trusts the host's proxy |

## Deploy for free (Render + Turso)

Render's free web service has no persistent disk, so the database lives on Turso's free plan (SQLite-compatible).

1. **Database (Turso):** sign up at https://turso.tech → create a database → copy its URL (`libsql://...`) and create a database token.
2. **Code (GitHub):** create an empty repository on GitHub and push this folder to it.
3. **App (Render):** at https://dashboard.render.com choose **New → Blueprint**, connect the GitHub repo (Render reads [render.yaml](render.yaml)), and enter `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` when asked.
4. Open the `https://<name>.onrender.com` URL Render gives you.

Free-tier note: the app sleeps after 15 idle minutes, so the first visit after a quiet period takes up to a minute to load. Data is not affected.

## Stack

- **Backend:** Node.js + Express, SQLite/Turso via `@libsql/client` ([server.js](server.js), [db.js](db.js))
- **Frontend:** plain HTML/CSS/JS, no build step ([public/](public/))
- **Auth:** passwords hashed with scrypt; sessions are random tokens stored in the DB and sent as an `HttpOnly` cookie (30 days)

## Database

| Table      | Contents                                                         |
|------------|------------------------------------------------------------------|
| `users`    | name, email (unique), password hash, theme                       |
| `sessions` | login tokens with expiry                                         |
| `tasks`    | per-user tasks: once or weekly (with weekdays), start / end date |
| `task_log` | one row per task per day: `done` or `missed`                     |

Every task and log endpoint checks that the task belongs to the signed-in user. Users can export/import their own data from **Settings**.
