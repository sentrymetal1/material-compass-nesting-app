# Node 20+: pdf-parse declares "node": ">=20.16.0 <21 || >=22.3.0". On node:18 it installed
# without complaint and then failed at runtime, so every PDF came back "could not read it" and
# fell through to guessing by filename. Node 18 is also past end of life.
FROM node:20-alpine

WORKDIR /app

# Install server dependencies
COPY package.json ./
RUN npm install --production

# Install client dependencies and build
COPY client/package.json client/
RUN cd client && npm install

COPY client/ client/
RUN cd client && npm run build

# Copy server
COPY server/ server/

EXPOSE 3000

CMD ["node", "server/index.js"]
