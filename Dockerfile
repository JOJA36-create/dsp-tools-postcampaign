FROM node:20-alpine

WORKDIR /app

COPY package.json server.js ./
COPY public ./public
RUN mkdir -p /app/data

ENV PORT=8787
ENV HOST=0.0.0.0

EXPOSE 8787

CMD ["node", "server.js"]
