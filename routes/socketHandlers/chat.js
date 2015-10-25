'use strict';

const dbConnector = require('../../databaseConnector');
const manager = require('../../manager');
const dbDefaults = require('../../config/dbPopDefaults');
const appConfig = require('../../config/appConfig');
const logger = require('../../logger');

function handle(socket) {
  socket.on('chatMsg', function(data) {
    manager.userAllowedCommand(socket.id, dbDefaults.commands.msg.commandName, function(allowErr, allowed) {
      if (allowErr || !allowed) {
        return;
      }

      const newData = data;
      const roomName = newData.message.whisper ? newData.roomName + dbDefaults.whisper : newData.roomName;

      newData.message.time = new Date();

      dbConnector.addMsgToHistory(roomName, newData.message, function(err, history) {
        if (err || null === history) {
          logger.sendErrorMsg(logger.ErrorCodes.db, 'Failed to add message to history', err);
          logger.sendSocketErrorMsg(socket, logger.ErrorCodes.db, 'Failed to send the message', err);
          return;
        }

        const newMessage = newData.message;

        newMessage.roomName = newData.roomName;

        socket.broadcast.to(roomName).emit('chatMsg', newMessage);

        if (!data.skipSelfMsg) {
          socket.emit('message', newMessage);
        }

        /*
         * Save the sent message in the sender's room history too, if it is a whisper
         */
        if (newData.message.whisper) {
          const whisperRoom = newData.message.user + dbDefaults.whisper;

          dbConnector.addMsgToHistory(whisperRoom, newData.message, function(histErr, foundHistory) {
            if (histErr || null === foundHistory) {
              logger.sendErrorMsg(logger.ErrorCodes.db, 'Failed to save whisper in senders history', histErr);
            }
          });
        }
      });
    });
  });

  socket.on('broadcastMsg', function(data) {
    manager.userAllowedCommand(socket.id, dbDefaults.commands.broadcast.commandName, function(allowErr, allowed) {
      if (allowErr || !allowed) {
        return;
      }

      data.time = new Date();

      dbConnector.addMsgToHistory('broadcast', data, function(err, history) {
        if (err || null === history) {
          logger.sendErrorMsg(logger.ErrorCodes.db, 'Failed to add message to history', err);
          return;
        }

        data.roomName = 'ALL';

        socket.broadcast.emit('broadcastMsg', data);
        socket.emit('message', data);
      });
    });
  });

  socket.on('createRoom', function(sentRoom) {
    manager.userAllowedCommand(socket.id, dbDefaults.commands.createroom.commandName,
      function(allowErr, allowed, user) {
      if (allowErr || !allowed || !user) {
        return;
      }

      manager.createRoom(sentRoom, user, function(createErr, roomName) {
        if (createErr) {
          return;
        }

        socket.emit('message', {
          text : [
            'Room has been created'
          ]
        });
        socket.join(roomName);
      });
    });
  });

  socket.on('follow', function(data) {
    manager.userAllowedCommand(socket.id, dbDefaults.commands.follow.commandName, function(allowErr, allowed, user) {
      if (allowErr || !allowed || !user) {
        return;
      }

      data.roomName = data.roomName.toLowerCase();

      if (data.password === undefined) {
        data.password = '';
      }
      dbConnector.authUserToRoom(user, data.roomName, data.password, function(err, room) {
        if (err || null === room) {
          logger.sendSocketErrorMsg(
            socket, logger.ErrorCodes.db, 'You are not authorized to join ' + data.roomName, err);
          return;
        }

        const roomName = room.roomName;

        dbConnector.addRoomToUser(user.userName, roomName, function(roomErr) {
          if (roomErr) {
            logger.sendErrorMsg(logger.ErrorCodes.db, 'Failed to follow ' + data.roomName, roomErr);
            return;
          }

          if (data.entered) {
            room.entered = true;
          }

          if (0 > socket.rooms.indexOf(roomName)) {
            socket.broadcast.to(roomName).emit('chatMsg', {
              text : [
                user.userName + ' is following ' + roomName
              ],
              room : roomName
            });
          }

          socket.join(roomName);
          socket.emit('follow', room);
        });
      });
    });
  });

  socket.on('switchRoom', function(room) {
    manager.userAllowedCommand(socket.id, dbDefaults.commands.switchroom.commandName, function(allowErr, allowed) {
      if (allowErr || !allowed) {
        return;
      }

      room.roomName = room.roomName.toLowerCase();

      if (0 < socket.rooms.indexOf(room.roomName)) {
        socket.emit('follow', room);
      } else {
        socket.emit('message', {
          text : ['You are not following room ' + room.roomName]
        });
      }
    });
  });

  socket.on('unfollow', function(room) {
    manager.userAllowedCommand(socket.id, dbDefaults.commands.unfollow.commandName, function(allowErr, allowed, user) {
      if (allowErr || !allowed || !user) {
        return;
      }

      const roomName = room.roomName.toLowerCase();

      if (-1 < socket.rooms.indexOf(roomName)) {
        const userName = user.userName;

        /*
         * User should not be able to unfollow its own room
         * That room is for private messaging between users
         */
        if (roomName !== userName) {
          dbConnector.removeRoomFromUser(userName, roomName, function(err, removedUser) {
            if (err || null === removedUser) {
              logger.sendSocketErrorMsg(socket, logger.ErrorCodes.db, 'Failed to unfollow room', err);
              return;
            }

            socket.broadcast.to(roomName).emit('chatMsg', {
              text : [userName + ' left ' + roomName],
              room : roomName
            });
            socket.leave(roomName);
            socket.emit('unfollow', room);
          });
        }
      } else {
        socket.emit('message',
          { text : ['You are not following ' + roomName] });
      }
    });
  });

  // Shows all available rooms
  socket.on('listRooms', function() {
    manager.userAllowedCommand(socket.id, dbDefaults.commands.list.commandName, function(allowErr, allowed, user) {
      if (allowErr || !allowed || !user) {
        return;
      }

      dbConnector.getAllRooms(user, function(roomErr, rooms) {
        if (roomErr) {
          logger.sendErrorMsg(logger.ErrorCodes.db, 'Failed to get all room names', roomErr);
          return;
        }

        if (0 < rooms.length) {
          let roomsString = '';

          for (let i = 0; i < rooms.length; i++) {
            roomsString += rooms[i].roomName + '\t';
          }

          socket.emit('message', {
            text : [
              '--------------',
              '  List rooms',
              '--------------',
              roomsString
            ]
          });
        }
      });
    });
  });

  socket.on('listUsers', function() {
    manager.userAllowedCommand(socket.id, dbDefaults.commands.list.commandName, function(allowErr, allowed, user) {
      if (allowErr || !allowed || !user) {
        return;
      }

      dbConnector.getAllUsers(user, function(userErr, users) {
        if (userErr || null === users) {
          logger.sendErrorMsg(logger.ErrorCodes.db, 'Failed to get all users', userErr);
          return;
        }

        if (0 < users.length) {
          let usersString = '';
          let onlineString = '';

          for (let i = 0; i < users.length; i++) {
            const currentUser = users[i];

            if (currentUser.verified && !currentUser.banned) {
              if (currentUser.online) {
                onlineString += currentUser.userName;
                onlineString += '\t';
              } else {
                usersString += currentUser.userName;
                usersString += '\t';
              }
            }
          }

          socket.emit('message', {
            text : [
              '--------------',
              '  List users',
              '--------------------',
              '  Currently online',
              '--------------------',
              onlineString,
              '-----------------',
              '  Other users',
              '-----------------',
              usersString
            ]
          });
        }
      });
    });
  });

  socket.on('myRooms', function(data) {
    function shouldBeHidden(room) {
      const hiddenRooms = [
        socket.id,
        data.userName + dbDefaults.whisper,
        data.device + dbDefaults.device,
        dbDefaults.rooms.important.roomName,
        dbDefaults.rooms.broadcast.roomName
      ];

      return 0 <= hiddenRooms.indexOf(room);
    }

    manager.userAllowedCommand(socket.id, dbDefaults.commands.myrooms.commandName, function(allowErr, allowed, user) {
      if (allowErr || !allowed) {
        return;
      }

      const rooms = [];

      for (let i = 0; i < socket.rooms.length; i++) {
        const room = socket.rooms[i];

        if (!shouldBeHidden(room)) {
          rooms.push(room);
        }
      }

      socket.emit('message', {
        text : [
          '------------',
          '  My rooms',
          '------------',
          'You are following rooms:',
          rooms.join('\t')
        ]
      });

      dbConnector.getOwnedRooms(user, function(err, ownedRooms) {
        if (err || null === ownedRooms) {
          logger.sendErrorMsg(logger.ErrorCodes.db, 'Failed to get owned rooms', err);
          return;
        }

        let ownedRoomsString = '';

        for (let i = 0; i < ownedRooms.length; i++) {
          ownedRoomsString += ownedRooms[i].roomName + '\t';
        }

        if (0 < ownedRoomsString.length) {
          socket.emit('message', {
            text : [
              'You are owner of the rooms:',
              ownedRoomsString
            ]
          });
        }
      });
    });
  });

  socket.on('history', function(data) {
    manager.userAllowedCommand(socket.id, dbDefaults.commands.history.commandName, function(allowErr, allowed) {
      if (allowErr || !allowed) {
        return;
      }

      const allRooms = socket.rooms;

      manager.getHistory(allRooms, data.lines, false, new Date(), function(histErr, historyMessages) {
        if (histErr) {
          logger.sendSocketErrorMsg(socket, logger.ErrorCodes.general, 'Unable to retrieve history', histErr);

          return;
        }

        while (0 < historyMessages.length) {
          socket.emit('multiMsg', historyMessages.splice(0, appConfig.chunkLength));
        }
      });
    });
  });

  socket.on('morse', function(data) {
    manager.userAllowedCommand(socket.id, dbDefaults.commands.morse.commandName, function(allowErr, allowed) {
      if (allowErr || !allowed) {
        return;
      }

      if (!data.local) {
        socket.broadcast.emit('morse', data.morseCode);
      }

      socket.emit('morse', data.morseCode);
    });
  });

  socket.on('removeRoom', function(roomName) {
    manager.userAllowedCommand(socket.id, dbDefaults.commands.removeroom.commandName,
      function(allowErr, allowed, user) {
      if (allowErr || !allowed || !user) {
        return;
      }

      const roomNameLower = roomName.toLowerCase();

      dbConnector.removeRoom(roomNameLower, user, function(err, room) {
        if (err || null === room) {
          logger.sendSocketErrorMsg(socket, logger.ErrorCodes.db, 'Failed to remove the room', err);
          return;
        }

        socket.emit('message', {
          text : ['Removed the room']
        });
      });
    });
  });

  socket.on('importantMsg', function(data) {
    const deviceFunc = function(roomName) {
      socket.to(roomName).emit('importantMsg', data);
    };
    const messageFunc = function() {
      socket.broadcast.emit('importantMsg', data);
      socket.emit('importantMsg', data);
    };
    const historyFunc = function(roomName, sendFunc) {
      dbConnector.addMsgToHistory(roomName, data, function(err, history) {
        if (err || null === history) {
          logger.sendSocketErrorMsg(socket, logger.ErrorCodes.db, 'Failed to send the message', err);
          return;
        }

        sendFunc(roomName);
      });
    };

    manager.userAllowedCommand(socket.id, dbDefaults.commands.importantmsg.commandName, function(allowErr, allowed) {
      if (allowErr || !allowed) {
        return;
      }

      data.time = new Date();

      if (data.device) {
        dbConnector.getDevice(data.device, function(err, device) {
          if (err || null === device) {
            logger.sendSocketErrorMsg(socket, logger.ErrorCodes.db, 'Failed to send the message to the device', err);
            return;
          }

          const deviceId = device.deviceId;
          const roomName = deviceId + dbDefaults.device;

          historyFunc(roomName, deviceFunc);

        });
      } else {
        const roomName = dbDefaults.rooms.important.roomName;

        historyFunc(roomName, messageFunc);
      }
    });
  });

  //TODO Change this, quick fix implementation
  socket.on('followPublic', function() {
    socket.join(dbDefaults.rooms.public.roomName);
  });

  socket.on('updateRoom', function(data) {
    manager.userAllowedCommand(socket.id, dbDefaults.commands.updateroom.commandName, function(allowErr, allowed) {
      if (allowErr || !allowed) {
        return;
      }

      const roomName = data.room;
      const field = data.field;
      const value = data.value;
      const callback = function(err, room) {
        if (err || null === room) {
          logger.sendSocketErrorMsg(socket, logger.ErrorCodes.db, 'Failed to update room', err);
          return;
        }

        socket.emit('message', {
          text : ['User has been updated']
        });
      };

      switch (field) {
        case 'visibility':
          dbConnector.updateRoomVisibility(roomName, value, callback);

          break;
        case 'accesslevel':
          dbConnector.updateRoomAccessLevel(roomName, value, callback);

          break;
        default:
          logger.sendSocketErrorMsg(socket, logger.ErrorCodes.db, 'Invalid field. Room doesn\'t have ' + field);

          break;
      }
    });
  });
}

exports.handle = handle;
