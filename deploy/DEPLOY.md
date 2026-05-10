# PERA Bodycam — Oracle Cloud Free Tier Deployment

Deploys the full stack (Python ML + .NET API + React + MSSQL-compatible DB +
nginx + Cloudflare Tunnel) onto a single free Oracle Cloud VM.

**Result:** Always-on `https://*.trycloudflare.com` URL, $0/month, 24 GB RAM ARM VM.

---

## Stage 1 — Oracle Cloud signup & VM creation (~15 min)

### 1.1 Sign up
1. Go to <https://signup.cloud.oracle.com/>
2. Fill in details. **Region:** pick "Mumbai (ap-mumbai-1)" or "Hyderabad (ap-hyderabad-1)" for low Pakistan latency.
3. Verify email, enter credit card (won't be charged unless you upgrade), pick a strong tenancy name.
4. Wait ~5 min for account activation email.

### 1.2 Create the Always Free ARM VM
1. Sign in → top-left ☰ menu → **Compute → Instances → Create Instance**.
2. Settings:
   - **Name:** `pera-bodycam`
   - **Image:** Click "Change image" → select **Canonical Ubuntu 22.04**
   - **Shape:** Click "Change shape" → tab **Ampere** → pick **VM.Standard.A1.Flex**
   - Set **OCPUs = 4** and **Memory = 24 GB** (max free)
3. **Networking:** leave defaults (auto-creates a VCN + public subnet)
4. **SSH key:** click "Generate a key pair for me" → click both **Save Private Key** and **Save Public Key**. Keep the `.key` file somewhere safe.
5. **Boot volume:** leave default (100 GB).
6. Click **Create**. Wait ~2 min for "RUNNING" state.

### 1.3 Note the public IP
On the instance details page, copy the **Public IP Address** (e.g. `152.67.x.x`). You'll use it as `<VM_IP>` below.

### 1.4 Open ports 80 + 443 in the cloud security list
1. On the instance page → Primary VNIC → click the **Subnet** link → click the **Default Security List**.
2. Click **Add Ingress Rules**. Add two rules:
   - Source CIDR `0.0.0.0/0`, IP Protocol **TCP**, Destination Port `80`
   - Source CIDR `0.0.0.0/0`, IP Protocol **TCP**, Destination Port `443`
3. Click **Add Ingress Rules** at the bottom.

---

## Stage 2 — Bootstrap the VM (~10 min)

### 2.1 SSH in
From your local PC, in Git Bash or WSL:
```bash
chmod 600 ~/Downloads/ssh-key-2026-XX-XX.key   # the file Oracle gave you
ssh -i ~/Downloads/ssh-key-2026-XX-XX.key ubuntu@<VM_IP>
```
Accept the host key when prompted.

### 2.2 Install Docker + tools
```bash
sudo apt-get update && sudo apt-get upgrade -y
sudo apt-get install -y ca-certificates curl gnupg git rsync
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | sudo tee /etc/apt/sources.list.d/docker.list
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker $USER
```
**Log out and back in** so the docker group takes effect:
```bash
exit
ssh -i ~/Downloads/ssh-key-2026-XX-XX.key ubuntu@<VM_IP>
docker --version
```

### 2.3 Open ports inside the VM (Oracle's iptables blocks them by default)
```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

---

## Stage 3 — Upload code & deploy (~15 min)

### 3.1 From your local PC, upload the project to the VM
In PowerShell on your laptop:
```powershell
# Adjust the .key path to where Oracle saved it
$key = "$env:USERPROFILE\Downloads\ssh-key-2026-XX-XX.key"
$ip  = "<VM_IP>"

# Tar & ship the three folders we need
cd C:\Projects
tar -czf pera-bodycam.tar.gz `
    --exclude='*/node_modules' `
    --exclude='*/dist' `
    --exclude='*/bin' `
    --exclude='*/obj' `
    --exclude='*/__pycache__' `
    --exclude='*/.venv' `
    --exclude='*/voiceprints/*' `
    --exclude='*/WatchFolder/Processed' `
    --exclude='*/WatchFolder/Failed' `
    EO-BodyCam-AI bodycam_dotnet deploy

scp -i $key pera-bodycam.tar.gz "ubuntu@${ip}:~/"
```

### 3.2 On the VM, extract and configure
```bash
mkdir -p ~/pera && cd ~/pera
tar -xzf ~/pera-bodycam.tar.gz
cd deploy
cp .env.example .env
nano .env       # paste your real GEMINI_API_KEY and pick a strong MSSQL_SA_PASSWORD
```
Save with `Ctrl+O Enter Ctrl+X`.

### 3.3 Build + start everything
```bash
cd ~/pera/deploy
docker compose --env-file .env build
docker compose --env-file .env up -d
docker compose ps               # all 5 services should be "running"
```
First build takes 10–20 min (Whisper model download + .NET restore + npm install).

### 3.4 Find your public URL
```bash
docker compose logs cloudflared | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | head -1
```
You'll see something like `https://random-words-1234.trycloudflare.com` — that's your public URL.

You can also reach it directly via VM IP: `http://<VM_IP>/`

---

## Stage 4 — Verify

```bash
curl -s https://YOUR-TUNNEL-URL.trycloudflare.com/api/analyse/health
# → {"ok":true,"service":"PERA360.Api/Analyse",...}

curl -s https://YOUR-TUNNEL-URL.trycloudflare.com/py-api/health
# → {"status":"healthy",...}
```
Open the tunnel URL in a browser → dashboard should load (with 0 recordings to start).

---

## Drop a video for analysis

```bash
# From your laptop, copy a video into the cloud VM's WatchFolder
scp -i $key -r my-video.mp4 ubuntu@<VM_IP>:~/pera/deploy/watch-folder/Inbox/
```
Within a few seconds the watcher picks it up; analysis takes 30–60 sec depending on length.

Or use the **Upload Audio / Gemini Analysis** menu in the UI to upload via browser.

---

## Common operations

```bash
# Tail logs
docker compose logs -f --tail=100

# Tail one service
docker compose logs -f dotnet

# Restart everything
docker compose restart

# Stop everything (data persists in volumes)
docker compose down

# Wipe everything including data (start fresh)
docker compose down -v

# Pull latest code from local PC again
# (re-run the scp command from Stage 3.1, then on VM:)
cd ~/pera && tar -xzf ~/pera-bodycam.tar.gz && cd deploy && docker compose up -d --build
```

---

## ⚠ Security checklist before sharing widely

- [ ] `MSSQL_SA_PASSWORD` is strong (16+ chars, mixed)
- [ ] `.env` is on the VM only, not in git
- [ ] Gemini key set to env var `GEMINI_API_KEY`, not in any committed file
- [ ] Cloudflare tunnel URL only shared with trusted users
- [ ] Watch your Gemini quota at <https://aistudio.google.com/app/usage>
- [ ] Set a Google billing budget alert (suggested: $5/day cap)

For a real production deployment you also want: API-key auth on the .NET endpoints, a real domain with TLS, log retention, and DB backups. Tell me when you're ready and I'll add them.
