FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY . .

# data.json lives here — mount a volume to persist it
VOLUME ["/app/data.json"]

EXPOSE 3000

CMD ["node", "server.js"]
