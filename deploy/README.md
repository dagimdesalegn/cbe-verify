# Deployment Guide

## 1. Prepare the server

    ssh root@your-server-ip
    curl -fsSL https://get.docker.com | sh
    apt install -y docker-compose-plugin
    mkdir -p /opt/cbe-verify && cd /opt/cbe-verify

## 2. Clone the project

    git clone https://github.com/dagimdesalegn/cbe-verify.git .

## 3. Create .env

    cat > .env <<EOF
    ADMIN_API_KEY=$(openssl rand -hex 32)
    WEBHOOK_SIGNING_SECRET=$(openssl rand -hex 32)
    EOF
    chmod 600 .env

## 4. Start the stack

    docker compose up -d
    docker compose logs -f api

## 5. Verify

    curl http://your-server-ip/health/live

## 6. Create a production key

    curl -X POST http://your-server-ip/api/api-keys \
      -H "content-type: application/json" \
      -H "x-api-key: $ADMIN_API_KEY" \
      -d '{"name":"Production"}'

## 7. Ethiopian relay (for Telebirr/M-Pesa URLs only)

On your Ethiopian server:

    docker build -f deploy/Dockerfile.relay -t cbe-verify-relay .
    docker run -d --restart unless-stopped --name cbe-verify-relay \
      -p 4000:4000 -e PORT=4000 -e RELAY_SECRET=your_secret cbe-verify-relay

Then on your main server .env:

    TELEBIRR_PROXY_URL=http://ethiopian-server-ip:4000/relay
    TELEBIRR_PROXY_SECRET=your_secret

Restart:

    docker compose restart api
