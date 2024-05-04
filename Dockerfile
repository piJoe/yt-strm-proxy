FROM node:22-slim

RUN mkdir -p /home/node/app/node_modules
WORKDIR /home/node/app

COPY package*.json ./
RUN npm install

COPY ./src .

COPY ./bin /home/node/app/bin

EXPOSE 9080

CMD [ "node", "index.js" ]