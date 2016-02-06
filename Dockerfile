FROM iojs:3.3.0

RUN mkdir -p /usr/src/app
WORKDIR /usr/src/app

ONBUILD COPY package.json /usr/src/app/
ONBUILD RUN npm install
ONBUILD COPY . /usr/src/app

CMD [ "npm", "install", $CONFIGPATH, "--save" ]
CMD [ "npm", "start" ]
EXPOSE 8888
