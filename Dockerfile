FROM node:24-alpine

ENV NODE_ENV=production \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning \
    PORT=8443 \
    HOST=0.0.0.0 \
    DB_PATH=/data/gateway.db

WORKDIR /app
COPY src/ ./src/

# `gw` admin command, and a data dir the non-root user can write to.
RUN printf '#!/bin/sh\nexec node /app/src/cli.js "$@"\n' > /usr/local/bin/gw \
 && chmod 755 /usr/local/bin/gw \
 && mkdir -p /data && chown node:node /data

USER node
VOLUME ["/data"]
EXPOSE 8443

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8443)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
