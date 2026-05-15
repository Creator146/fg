# Mini Racer 3D PRO — GitHub + Render Deployment Guide

## What's in this zip

| File | Purpose |
|------|---------|
| `index.html` | Full game — already wired to load `/f1car.glb` |
| `server.js` | Express + WebSocket server — serves the GLB with correct MIME type, uses `process.env.PORT` for Render |
| `package.json` | Node.js dependencies (`express`, `ws`) |
| `f1car.glb` | The real F1 3D model (2.5 MB) |
| `.gitignore` | Keeps `node_modules/` out of Git |

---

## Step 1 — Create a GitHub repository

1. Go to [https://github.com/new](https://github.com/new)
2. Name it anything, e.g. `mini-racer`
3. Set it to **Public** (Render free tier requires public repos, or connect a private one with a paid plan)
4. **Do NOT** tick "Add a README" — leave the repo empty
5. Click **Create repository**

---

## Step 2 — Push the files to GitHub

Open a terminal in the folder where you unzipped these files, then run:

```bash
git init
git add .
git commit -m "Initial commit — Mini Racer with F1 GLB model"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/mini-racer.git
git push -u origin main
```

> Replace `YOUR_USERNAME/mini-racer` with your actual GitHub repo URL shown after you created it.

**Important:** `f1car.glb` is 2.5 MB. GitHub allows files up to 100 MB, so it will push fine without Git LFS.

---

## Step 3 — Deploy on Render

1. Go to [https://render.com](https://render.com) and sign in (or create a free account)
2. Click **New +** → **Web Service**
3. Connect your GitHub account if not already connected
4. Select your `mini-racer` repository
5. Fill in the settings:

| Setting | Value |
|---------|-------|
| **Name** | `mini-racer` (or anything you like) |
| **Region** | Closest to you |
| **Branch** | `main` |
| **Runtime** | `Node` |
| **Build Command** | `npm install` |
| **Start Command** | `npm start` |
| **Instance Type** | Free |

6. Click **Create Web Service**
7. Wait ~2 minutes for the first deploy to finish

---

## Step 4 — Verify it works

Once deployed, test these two URLs (replace `YOUR-APP` with your Render app name):

- `https://YOUR-APP.onrender.com/` — should load the game
- `https://YOUR-APP.onrender.com/f1car.glb` — should download or show binary content (confirms the GLB is served correctly)

When you open the game, you should see the toast message **"Real F1 model loaded"** in the bottom-center of the screen.

---

## How the wiring works

- `index.html` uses `GLTFLoader` to fetch `/f1car.glb` (a root-relative URL)
- `server.js` serves all files in the same directory via `express.static(__dirname)`
- The `.glb` MIME type is explicitly set to `model/gltf-binary` so browsers don't reject it
- The server listens on `process.env.PORT` which Render sets automatically

No changes were needed to the code — the wiring was already correct. You just needed all four files in the same directory.

---

## Local testing (optional)

```bash
npm install
npm start
# Open http://localhost:3000
```
