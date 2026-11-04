FROM node:22-bookworm-slim

WORKDIR /usr/src/app
COPY package.json server.js index.html ./

RUN mkdir -p /app/data && chmod 777 /app/data
ENV NODE_ENV=production
ENV DATA_DIR=/app/data
EXPOSE 3000

CMD ["node", "server.js"]
