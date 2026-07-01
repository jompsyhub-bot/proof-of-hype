FROM node:24-slim

WORKDIR /app
COPY package.json package.json
COPY src src
COPY public public
COPY README.md README.md

ENV NODE_ENV=production
ENV PORT=8787
ENV DATABASE_PATH=/app/data/proof-of-hype.sqlite

RUN mkdir -p /app/data

EXPOSE 8787
CMD ["node", "src/server.js"]
