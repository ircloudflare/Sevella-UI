# ---------- Stage 1: fetch Xray-core binary ----------
FROM alpine:3.19 AS xray-fetch

RUN apk add --no-cache curl unzip ca-certificates

# Sevalla builds/runs Docker images as linux/amd64.
RUN curl -L -o /tmp/xray.zip \
      "https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-64.zip" \
    && unzip /tmp/xray.zip -d /tmp/xray \
    && install -m 0755 /tmp/xray/xray /usr/local/bin/xray

# ---------- Stage 2: runtime image ----------
FROM node:20-alpine

RUN apk add --no-cache ca-certificates

WORKDIR /app

COPY --from=xray-fetch /usr/local/bin/xray /usr/local/bin/xray

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY server.js ./
COPY public ./public

RUN mkdir -p /app/data

# Sevalla injects PORT at runtime (defaults to 8080 if you don't set one in the panel)
ENV PORT=8080
ENV WS_PATH=parsaw

EXPOSE 8080

CMD ["node", "server.js"]
