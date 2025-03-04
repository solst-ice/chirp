FROM node:alpine3.21 as node

EXPOSE 5173

WORKDIR /app

COPY . .

RUN yarn

CMD ["yarn", "dev", "--host"]