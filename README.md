# In Pursuit of Stolen Ghosts | Duet in Latent Space | Generative Version



## About the project

**In Pursuit of Stolen Ghosts | Duet in Latent Space** is a work by Marlon Barrios Solano, developed during an artistic and research residency at Lake Studios Berlin (February 2024). The piece sits at the intersection of generative AI, sound, and performance, using **latent space** as a metaphor for what is remembered, distorted, and re-generated.

The work reflects on cultural loss and diaspora—especially a personal thread tied to Venezuelan heritage and migration. The “stolen ghost” names the feeling of ancestral and collective memory that can no longer be fully recovered; the app is one surface where sketch, sound, and model output meet.

## What this application does

This repository is a **Next.js** web app—not the older p5.js circle sketch described in earlier docs.

- **Left:** [Excalidraw](https://excalidraw.com/) panel. You draw; the scene is exported as a JPEG data URL (throttled) and sent to Fal.
- **Right:** Live preview driven by **Fal realtime** WebSockets ([FLUX.2 Klein realtime](https://fal.ai/models/fal-ai/flux-2/klein/realtime) by default): image-to-image over a persistent connection with **msgpack** frames.
- **Audio:** Looping track (`public/ghost_stolen.mp3`).

The text prompt that steers style and content (hieroglyphic / cave / oil / memory / South America / abstract biology, etc.) defaults in **`app/page.tsx`** as `DEFAULT_REALTIME_PROMPT`. Override without rebuilding the bundle text by setting **`NEXT_PUBLIC_FAL_PROMPT`** (see env table below).

### Stack

- Next.js (App Router), React, TypeScript, Tailwind CSS  
- `@fal-ai/client` (`fal.realtime.connect`) + `@fal-ai/serverless-proxy`  
- Short-lived JWT from **`POST /api/fal/realtime-token`** (server `FAL_KEY`)  
- Optional **`/api/fal/proxy`** for REST calls (e.g. token sanity check)

## Explore more

- **Live app:** [in-pursuit-of-stolen-ghosts.vercel.app](https://in-pursuit-of-stolen-ghosts.vercel.app/)
- **Marlon Barrios Solano:** [Linktree](https://linktr.ee/marlonbarriososolano)

![Image of performance](https://github.com/marlonbarrios/fall-ai-turbo/blob/mondrian/public/ghost2.jpg?raw=true 'Image of performance')

## Getting started

### Prerequisites

- Node.js 18+ (or current LTS recommended)
- A [Fal](https://fal.ai/) API key with access to your chosen realtime model

### Environment variables

Create **`.env.local`** in the project root (never commit secrets):

| Variable | Where | Purpose |
|----------|--------|---------|
| `FAL_KEY` | Server | Minting JWTs in `/api/fal/realtime-token` and Fal REST via proxy |
| `NEXT_PUBLIC_FAL_REALTIME_APP` | Client (optional) | Override default endpoint id (default: `fal-ai/flux-2/klein/realtime`) |
| `NEXT_PUBLIC_FAL_PROMPT` | Client (optional) | **Full** realtime prompt string. Use if the default in `app/page.tsx` is too long combined with the sketch and the WebSocket stops returning frames. |

Restart `npm run dev` after changing env vars. For Vercel, add the same names in **Settings → Environment Variables** and redeploy.

### Install and run

```bash
git clone https://github.com/marlonbarrios/in-pursuit-of-stolen-ghosts.git
cd in-pursuit-of-stolen-ghosts
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Draw on the left; the right panel should update when Fal returns frames (non-empty sketch required).

### Build

```bash
npm run build
npm start
```

### Debugging

In development, the browser console may show lines prefixed with **`[Fal]`** (token check, WebSocket, frame receive/paint). If the preview stays empty, confirm `FAL_KEY`, draw real strokes, and inspect those messages and the **Network → WS** tab for `wss://fal.run/...`.

If it **used to work** and stopped after **long prompt** edits, the combined **prompt + JPEG data URL** may be too large for a reliable realtime message. Set a shorter **`NEXT_PUBLIC_FAL_PROMPT`** (single line in `.env.local`) or shorten `DEFAULT_REALTIME_PROMPT` in code; the sketch export is capped (~640px JPEG) to keep payloads smaller.

If **`npm run dev`** crashes or the browser shows errors like **`Cannot find module './XXXX.js'`** under `.next/server`, the dev cache is out of sync. Stop the dev server, run **`rm -rf .next`**, then **`npm run dev`** again (or run **`npm run build`** once to verify a clean compile).

## License

MIT License

Copyright (c) 2024 Marlon Barrios Solano

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
