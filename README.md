# Family Chat

A private chat for two (or a few) people. It runs in the phone's browser and installs to the Home Screen like a normal app.

- Live messages over WebSockets
- "Serdar is typing…" indicator, plus an optional live preview of what the other person is typing (each person turns it on for themselves in Settings ⋯)
- Read receipts: "Delivered" turns into "Seen"
- Online / offline dot
- Phone notifications through Web Push, even when the app is closed (Android, and iPhone with iOS 16.4+ once added to the Home Screen)
- One login per person, stored in an environment variable
- Messages are kept in JSON files in `DATA_DIR`

## How notifications work

1. When you tap **Turn on** in the app, the phone asks for permission and gives the app a private push address (from Apple or Google).
2. The app sends that address to your server.
3. When one of you sends a message, the server checks whether the other person has the chat open on screen. If not, it sends an encrypted push to their address, and the phone shows "Serdar: are you home?".
4. Tapping the notification opens the chat. Several messages in a row are grouped into one notification.

The server signs pushes with a "VAPID" key pair. Keep the same keys forever (set them as environment variables), otherwise phones have to turn notifications on again.

## Settings (environment variables)

| Name | Example | What it is |
|---|---|---|
| `USERS` | `Serdar:long-password-1,Ali:long-password-2` | Each person's name and password |
| `SESSION_SECRET` | from `npm run keys` | Keeps you logged in across restarts |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | from `npm run keys` | Signs push notifications |
| `VAPID_SUBJECT` | `mailto:you@example.com` | Contact address push services can use |
| `DATA_DIR` | `/data` | Where messages are saved |

Run `npm install && npm run keys` once on any computer to print fresh values for the three secrets.

## Run it on your computer

```sh
npm install
USERS="Serdar:pass1,Ali:pass2" npm start
# open http://localhost:3000
```

Push notifications need HTTPS, so test them on the real hosted version.

## Put it online

The server must stay running and keep its files, so pick a host with an always-on machine and a disk.

### Our AWS server (the one Provenorsk runs on)

It runs next to the other apps as its own systemd service on port 8790, behind nginx with a free Let's Encrypt certificate.

1. Point a subdomain (for example `chat.provenorsk.no`) at the server with a DNS **A record** to `44.233.47.251`.
2. On the server:
   ```sh
   cd /home/ubuntu
   git clone https://github.com/tugceozgur/family-chat.git
   cd family-chat
   bash deploy/setup.sh chat.provenorsk.no you@example.com
   nano .env        # set the real names and passwords in USERS
   sudo systemctl restart family-chat
   ```
3. Later updates: `cd ~/family-chat && bash deploy/deploy.sh`
4. Logs: `journalctl -u family-chat -f`

Chat history lives in `/home/ubuntu/family-chat-data`, outside the code folder.

### Fly.io (, roughly $2–3 a month)

1. Install the `fly` command and sign up: https://fly.io/docs/flyctl/install/
2. In this folder, change `app = "family-chat-change-me"` in `fly.toml` to a unique name.
3. Run:
   ```sh
   fly launch --copy-config --no-deploy
   fly volumes create chat_data --size 1
   fly secrets set USERS="Serdar:pass1,Ali:pass2" SESSION_SECRET=... VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:you@example.com
   fly deploy
   ```
4. Open `https://<your-app-name>.fly.dev`.

### Render (free, with a catch)

Push `render.yaml` in a GitHub repo, then on render.com choose **New → Blueprint** and fill in the variables. The free plan sleeps after 15 minutes without visitors and has no lasting disk, so **chat history is wiped whenever it sleeps or restarts**, and the first message after a nap takes up to a minute. It is fine for trying it out. For real use, switch to a paid Render plan with a disk, or use Fly.io.

### Your own computer or a Raspberry Pi

Run it with Docker (`docker build -t family-chat . && docker run -p 8080:8080 -v chat:/data -e USERS=... family-chat`) and expose it with a free Cloudflare Tunnel to get HTTPS.

## Set it up on your phones

**iPhone (iOS 16.4 or newer)**
1. Open the site in **Safari**.
2. Tap **Share** ⬆︎ → **Add to Home Screen** → **Add**.
3. Open **Family** from the Home Screen (not from Safari), log in, and tap **Turn on** → **Allow**.

**Android**
1. Open the site in **Chrome** and log in.
2. Tap **Turn on** → **Allow**.
3. Chrome menu ⋮ → **Add to Home screen** (or **Install app**).

If notifications stop arriving, open Settings ⋯ in the app and switch **Notifications on this device** off and on.
