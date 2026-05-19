# VOID Fashion Store — Deployment Guide

## Quick Local Start
```bash
npm install
cp .env.example .env
# Edit .env if needed
npm start
```
Visit → http://localhost:3000  
Admin  → http://localhost:3000/admin.html  (password: `void2025`)

---

## Worldwide Deployment (Railway / Render / Fly.io)

### 1 — Set up Cloudinary (free image CDN)
1. Create a free account at **https://cloudinary.com**
2. Copy your **API Environment variable** from the dashboard  
   (looks like: `cloudinary://API_KEY:API_SECRET@CLOUD_NAME`)
3. Add it as an environment variable: `CLOUDINARY_URL`

Without Cloudinary, images saved to disk will vanish on server restarts.

### 2 — Deploy on Railway
```bash
# Install Railway CLI
npm i -g @railway/cli
railway login
railway new
railway up
```
Add env vars in the Railway dashboard:
| Variable | Value |
|---|---|
| `ADMIN_PASSWORD` | your-strong-password |
| `JWT_SECRET` | random-long-string |
| `CLOUDINARY_URL` | cloudinary://... |

### 3 — Deploy on Render
- New **Web Service** → connect your repo
- Build command: `npm install`
- Start command: `npm start`
- Add the same env vars in the Render dashboard

### 4 — Deploy on Fly.io
```bash
fly launch
fly secrets set ADMIN_PASSWORD=yourpassword JWT_SECRET=yoursecret CLOUDINARY_URL=cloudinary://...
fly deploy
```

---

## Environment Variables Reference
| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | 3000 | Server port |
| `ADMIN_PASSWORD` | Yes (prod) | void2025 | Admin panel password |
| `JWT_SECRET` | Yes (prod) | built-in | JWT signing secret |
| `CLOUDINARY_URL` | Yes (prod) | — | Cloudinary API URL for global image storage |
