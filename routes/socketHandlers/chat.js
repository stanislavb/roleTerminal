'use strict';

const dbConnector = require('../../databaseConnector');
const manager = require('../../manager');
const databasePopulation = require('rolehaven-config').databasePopulation;
const appConfig = require('rolehaven-config').app;
const logger = require('../../logger');
const messenger = require('../../messenger');
const objectValidator = require('../../objectValidator');

function followRoom(params) {
  const socket = params.socket;
  const newRoom = params.newRoom;
  const newRoomName = newRoom.roomName;

  if (Object.keys(socket.rooms).indexOf(newRoomName) < 0) {
    messenger.sendMsg({
      socket: socket,
      message: {
        text: [params.userName + ' is following ' + newRoomName],
        text_se: [params.username + ' följer ' + newRoomName],
        roomName: newRoomName,
      },
      sendTo: newRoomName,
    });
  }

  socket.join(newRoomName);
  socket.emit('follow', { room: newRoom });
  socket.emit('commandSuccess', { noStepCall: true });
}

function shouldBeHidden(room, socketId) {
  const hiddenRooms = [
    socketId,
    databasePopulation.rooms.important.roomName,
    databasePopulation.rooms.broadcast.roomName,
    databasePopulation.rooms.morse.roomName,
  ];

  return hiddenRooms.indexOf(room) >= 0 || room.indexOf(appConfig.whisperAppend) >= 0 || room.indexOf(appConfig.deviceAppend) >= 0 || room.indexOf(appConfig.teamAppend) >= 0;
}

function handle(socket, io) {
  socket.on('chatMsg', function(data) {
    if (!objectValidator.isValidData(data, { message: { text: true, roomName: true } })) {
      return;
    }

    manager.userAllowedCommand(socket.id, databasePopulation.commands.msg.commandName, function(allowErr, allowed, user) {
      if (allowErr || !allowed) {
        return;
      }

      data.message.userName = user.userName;

      if (data.message.roomName === 'team') {
        data.message.roomName = user.team + appConfig.teamAppend;
      }

      messenger.sendChatMsg({ socket: socket, message: data.message });
    });
  });

  socket.on('whisperMsg', function(data) {
    if (!objectValidator.isValidData(data, { message: { text: true, roomName: true, whisper: true } })) {
      return;
    }

    manager.userAllowedCommand(socket.id, databasePopulation.commands.whisper.commandName, function(allowErr, allowed, user) {
      if (allowErr || !allowed) {
        return;
      }

      data.message.userName = user.userName;

      messenger.sendWhisperMsg({ socket: socket, message: data.message });
    });
  });

  socket.on('broadcastMsg', function(data) {
    if (!objectValidator.isValidData(data, { message: { text: true } })) {
      return;
    }

    manager.userAllowedCommand(socket.id, databasePopulation.commands.broadcast.commandName, function(allowErr, allowed, user) {
      if (allowErr || !allowed) {
        return;
      }

      data.message.userName = user.userName;

      messenger.sendBroadcastMsg({ socket: socket, message: data.message });
    });
  });

  socket.on('createRoom', function(data) {
    if (!objectValidator.isValidData(data, { room: { roomName: true, owner: true } })) {
      return;
    }

    manager.userAllowedCommand(socket.id, databasePopulation.commands.createroom.commandName, function(allowErr, allowed, user) {
      if (allowErr || !allowed || !user) {
        return;
      }

      manager.createRoom(data.room, user, function(createErr, roomName) {
        if (createErr) {
          logger.sendSocketErrorMsg({
            socket: socket,
            code: logger.ErrorCodes.db,
            text: ['Failed to create room'],
            text_se: ['Lyckades inte skapa rummet'],
            err: createErr,
          });

          return;
        } else if (!roomName) {
          messenger.sendSelfMsg({
            socket: socket,
            message: {
              text: ['Failed to create room. A room with that name already exists'],
              text_se: ['Lyckades inte skapa rummet. Ett rum med det namnet existerar redan'],
            },
          });

          return;
        }

        const room = {};
        room.roomName = roomName;

        messenger.sendSelfMsg({
          socket: socket,
          message: {
            text: ['Room has been created'],
            text_se: ['Rummet har skapats'],
          },
        });
        followRoom({ socket: socket, userName: user.userName, newRoom: room });
      });
    });
  });

  socket.on('follow', function(data) {
    if (!objectValidator.isValidData(data, { room: { roomName: true } })) {
      socket.emit('commandFail');

      return;
    }

    manager.userAllowedCommand(socket.id, databasePopulation.commands.follow.commandName, function(allowErr, allowed, user) {
      if (allowErr || !allowed || !user) {
        socket.emit('commandFail');

        return;
      }

      const roomName = data.room.roomName.toLowerCase();
      // TODO Move toLowerCase to class
      data.room.roomName = roomName;

      if (data.room.password === undefined) {
        data.room.password = '';
      }

      dbConnector.authUserToRoom(user, roomName, data.room.password, function(err, room) {
        if (err || room === null) {
          logger.sendSocketErrorMsg({
            socket: socket,
            code: logger.ErrorCodes.db,
            text: ['You are not authorized to join ' + roomName],
            text_se: ['Ni har inte tillåtelse att gå in i rummet ' + roomName],
            err: err,
          });
          socket.emit('commandFail');

          return;
        }

        dbConnector.addRoomToUser(user.userName, room.roomName, function(roomErr) {
          if (roomErr) {
            logger.sendErrorMsg({
              code: logger.ErrorCodes.db,
              text: ['Failed to follow ' + roomName],
              err: roomErr,
            });
            socket.emit('commandFail');

            return;
          }

          room.entered = data.room.entered;

          followRoom({ socket: socket, userName: user.userName, newRoom: room });
        });
      });
    });
  });

  socket.on('switchRoom', function(data) {
    if (!objectValidator.isValidData(data, { room: { roomName: true } })) {
      return;
    }

    manager.userAllowedCommand(socket.id, databasePopulation.commands.switchroom.commandName, function(allowErr, allowed, user) {
      if (allowErr || !allowed) {
        return;
      }

      let roomName = data.room.roomName.toLowerCase();

      if (user.team && roomName === 'team') {
        roomName = user.team + appConfig.teamAppend;
        data.room.roomName = 'team';
      }

      if (Object.keys(socket.rooms).indexOf(roomName) > 0) {
        socket.emit('follow', { room: data.room });
      } else {
        messenger.sendSelfMsg({
          socket: socket,
          message: {
            text: ['You are not following room ' + roomName],
            text_se: ['Ni följer inte rummet' + roomName],
          },
        });
      }
    });
  });

  socket.on('unfollow', function(data) {
    if (!objectValidator.isValidData(data, { room: { roomName: true } })) {
      return;
    }

    manager.userAllowedCommand(socket.id, databasePopulation.commands.unfollow.commandName, function(allowErr, allowed, user) {
      if (allowErr || !allowed || !user) {
        return;
      }

      // TODO Move toLowerCase to class
      const roomName = data.room.roomName.toLowerCase();

      if (Object.keys(socket.rooms).indexOf(roomName) > -1) {
        const userName = user.userName;

        /*
         * User should not be able to unfollow its own room
         * That room is for private messaging between users
         */
        if (roomName !== userName) {
          dbConnector.removeRoomFromUser(userName, roomName, function(err, removedUser) {
            if (err || removedUser === null) {
              logger.sendSocketErrorMsg({
                socket: socket,
                code: logger.ErrorCodes.db,
                text: ['Failed to unfollow room'],
                text_se: ['Misslyckades med att följa rummet'],
                err: err,
              });

              return;
            }

            messenger.sendMsg({
              socket: socket,
              message: {
                text: [userName + ' left ' + roomName],
                text_se: [userName + ' lämnade' + roomName],
                roomName: roomName,
              },
              sendTo: roomName,
            });
            socket.leave(roomName);
            socket.emit('unfollow', { room: data.room });
          });
        }
      } else {
        messenger.sendSelfMsg({
          socket: socket,
          message: {
            text: ['You are not following ' + roomName],
            text_se: ['Ni följer inte ' + roomName],
          },
        });
      }
    });
  });

  // Shows all available rooms
  socket.on('listRooms', function() {
    manager.userAllowedCommand(socket.id, databasePopulation.commands.list.commandName, function(allowErr, allowed, user) {
      if (allowErr || !allowed || !user) {
        return;
      }

      dbConnector.getAllRooms(user, function(roomErr, rooms) {
        if (roomErr) {
          logger.sendErrorMsg({
            code: logger.ErrorCodes.db,
            text: ['Failed to get all room names'],
            err: roomErr,
          });

          return;
        }

        if (rooms.length > 0) {
          const roomNames = [];

          for (let i = 0; i < rooms.length; i++) {
            roomNames.push(rooms[i].roomName);
          }

          messenger.sendList({
            socket: socket,
            itemList: {
              listTitle: 'List rooms',
              itemList: roomNames,
            },
          });
        }
      });
    });
  });

  socket.on('listUsers', function() {
    manager.userAllowedCommand(socket.id, databasePopulation.commands.list.commandName, function(allowErr, allowed, user) {
      if (allowErr || !allowed || !user) {
        return;
      }

      dbConnector.getAllUsers(user, function(userErr, users) {
        if (userErr || users === null) {
          logger.sendErrorMsg({
            code: logger.ErrorCodes.db,
            text: ['Failed to get all users'],
            err: userErr,
          });

          return;
        }

        if (users.length > 0) {
          const offlineUsers = [];
          const onlineUsers = [];

          for (let i = 0; i < users.length; i++) {
            const currentUser = users[i];

            if ((!appConfig.userVerify || currentUser.verified) && !currentUser.banned) {
              if (currentUser.online) {
                onlineUsers.push(currentUser.userName);
              } else {
                offlineUsers.push(currentUser.userName);
              }
            }
          }

          messenger.sendList({
            socket: socket,
            itemList: {
              listTitle: 'Online users',
              itemList: onlineUsers,
            },
          });
          messenger.sendList({
            socket: socket,
            itemList: {
              listTitle: 'Other users',
              itemList: offlineUsers,
            },
          });
        }
      });
    });
  });

  // TODO Data structure. data.user.userName?
  socket.on('myRooms', function(data) {
    if (!objectValidator.isValidData(data, { user: { userName: true }, device: { deviceId: true } })) {
      return;
    }

    manager.userAllowedCommand(socket.id, databasePopulation.commands.myrooms.commandName, function(allowErr, allowed, user) {
      if (allowErr || !allowed) {
        return;
      }

      const rooms = [];
      const socketRooms = Object.keys(socket.rooms);

      if (user.team) {
        rooms.push('team');
      }

      for (let i = 0; i < socketRooms.length; i++) {
        const room = socketRooms[i];

        if (!shouldBeHidden(room, socket.id)) {
          rooms.push(room);
        }
      }

      messenger.sendList({
        socket: socket,
        itemList: {
          listTitle: 'My rooms',
          itemList: rooms,
        },
      });

      dbConnector.getOwnedRooms(user, function(err, ownedRooms) {
        if (err || !ownedRooms || ownedRooms === null) {
          logger.sendErrorMsg({
            code: logger.ErrorCodes.db,
            text: ['Failed to get owned rooms'],
            err: err,
          });

          return;
        }

        if (ownedRooms.length > 0) {
          const roomNames = [];

          for (let i = 0; i < ownedRooms.length; i++) {
            roomNames.push(ownedRooms[i].roomName);
          }

          messenger.sendList({
            socket: socket,
            itemList: {
              listTitle: 'You are owner of the rooms:',
              itemList: roomNames,
            },
          });
        }
      });
    });
  });

  socket.on('history', function(data) {
    if (!objectValidator.isValidData(data, {})) {
      return;
    }

    manager.userAllowedCommand(socket.id, databasePopulation.commands.history.commandName, function(allowErr, allowed, user) {
      if (allowErr || !allowed) {
        return;
      } else if (data.room && Object.keys(socket.rooms).indexOf(data.room.roomName) < 0) {
        logger.sendSocketErrorMsg({
          socket: socket,
          code: logger.ErrorCodes.general,
          text: [`${user.userName} is not following room ${data.room.roomName}. Unable to retrieve history`],
          text_se: [`${user.userName} följer inte rummet ${data.room.roomName}. Misslyckades med hämtningen av historik`],
        });

        return;
      }

      const allRooms = data.room ? [data.room.roomName] : Object.keys(socket.rooms);
      const startDate = data.startDate || new Date();

      manager.getHistory(allRooms, data.lines, false, startDate, function(histErr, historyMessages) {
        if (histErr) {
          logger.sendSocketErrorMsg({
            socket: socket,
            code: logger.ErrorCodes.general,
            text: ['Unable to retrieve history'],
            text_se: ['Misslyckades med hämtningen av historik'],
            err: histErr,
          });

          return;
        }

        while (historyMessages.length > 0) {
          messenger.sendSelfMsgs({ socket: socket, messages: historyMessages.splice(0, appConfig.chunkLength) });
        }
      });
    });
  });

  socket.on('morse', function(data) {
    if (!objectValidator.isValidData(data, { morseCode: true })) {
      return;
    }

    manager.userAllowedCommand(socket.id, databasePopulation.commands.morse.commandName, function(allowErr, allowed) {
      if (allowErr || !allowed) {
        return;
      }

      messenger.sendMorse({
        socket: socket,
        local: data.local,
        message: {
          morseCode: data.morseCode,
        },
        silent: data.silent,
      });
    });
  });

  socket.on('removeRoom', function(data) {
    if (!objectValidator.isValidData(data, { room: { roomName: true } })) {
      return;
    }

    manager.userAllowedCommand(socket.id, databasePopulation.commands.removeroom.commandName, function(allowErr, allowed, user) {
      if (allowErr || !allowed || !user) {
        return;
      }

      const roomNameLower = data.room.roomName.toLowerCase();

      dbConnector.removeRoom(roomNameLower, user, function(err, room) {
        if (err || room === null) {
          logger.sendSocketErrorMsg({
            socket: socket,
            code: logger.ErrorCodes.db,
            text: ['Failed to remove the room'],
            text_se: ['Misslyckades med att ta bort rummet'],
            err: err,
          });

          return;
        }

        dbConnector.removeRoomFromAllUsers(roomNameLower, function(roomErr) {
          if (roomErr) {
            logger.sendSocketErrorMsg({
              socket: socket,
              code: logger.ErrorCodes.db,
              text: ['Failed to remove room from all users'],
              text_se: ['Misslyckades med att ta bort rummet från alla användare'],
              err: roomErr,
            });
          }

          const connectedIds = io.sockets.adapter.rooms[roomNameLower].sockets;
          const allSockets = io.sockets.connected;

          for (let i = 0; i < connectedIds.length; i++) {
            const userSocket = allSockets[connectedIds[i]];

            userSocket.leave(roomNameLower);
          }

          socket.broadcast.to(roomNameLower).emit('unfollow', { room: data.room });
        });

        messenger.sendSelfMsg({
          socket: socket,
          message: {
            text: ['Removed the room'],
            text_se: ['Rummet borttaget'],
          },
        });
        messenger.sendMsg({
          socket: socket,
          message: {
            text: ['Room ' + roomNameLower + ' has been removed by the room administrator'],
            text_se: ['Rummet ' + roomNameLower + ' har blivit borttaget av en administratör för rummet'],
          },
          sendTo: roomNameLower,
        });
      });
    });
  });

  socket.on('importantMsg', function(data) {
    if (!objectValidator.isValidData(data, { message: { text: true } })) {
      return;
    }

    manager.userAllowedCommand(socket.id, databasePopulation.commands.importantmsg.commandName, function(allowErr, allowed) {
      if (allowErr || !allowed) {
        return;
      }

      if (data.device) {
        dbConnector.getDevice(data.device, function(err, device) {
          if (err || device === null) {
            logger.sendSocketErrorMsg({
              socket: socket,
              code: logger.ErrorCodes.db,
              text: ['Failed to send the message to the device'],
              text_se: ['Misslyckades med att skicka meddelande till enheten'],
              err: err,
            });

            return;
          }

          data.roomName = device.deviceId + appConfig.deviceAppend;

          messenger.sendImportantMsg({
            socket: socket,
            message: data.message,
            toOneDevice: true,
          });

          if (data.morse) {
            messenger.sendMorse({
              socket: socket,
              local: data.morse.local,
              message: {
                roomName: data.roomName,
                morseCode: data.morse.morseCode,
              },
            });
          }
        });
      } else {
        messenger.sendImportantMsg({
          socket: socket,
          message: data.message,
        });

        if (data.morse) {
          messenger.sendMorse({
            socket: socket,
            local: data.morse.local,
            message: {
              morseCode: data.morse.morseCode,
            },
          });
        }
      }
    });
  });

  // TODO Change this, quick fix implementation
  socket.on('followPublic', function() {
    socket.join(databasePopulation.rooms.public.roomName);
  });

  socket.on('updateRoom', function(data) {
    if (!objectValidator.isValidData(data, { room: { roomName: true }, field: true, value: true })) {
      return;
    }

    manager.userAllowedCommand(socket.id, databasePopulation.commands.updateroom.commandName, function(allowErr, allowed) {
      if (allowErr || !allowed) {
        return;
      }

      const roomName = data.room.roomName;
      const field = data.field;
      const value = data.value;
      const callback = function(err, room) {
        if (err || room === null) {
          logger.sendSocketErrorMsg({
            socket: socket,
            code: logger.ErrorCodes.db,
            text: ['Failed to update room'],
            text_se: ['Misslyckades med att uppdatera rummet'],
            err: err,
          });

          return;
        }

        messenger.sendSelfMsg({
          socket: socket,
          message: {
            text: ['Room has been updated'],
            text_se: ['Rummet har uppdaterats'],
          },
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
        logger.sendSocketErrorMsg({
          socket: socket,
          code: logger.ErrorCodes.db,
          text: ['Invalid field. Room doesn\'t have ' + field],
          text_se: ['Felaktigt fält. Rum har inte fältet ' + field],
        });

        break;
      }
    });
  });

  socket.on('matchPartialMyRoom', function(data) {
    // data.partialName is not checked if it set, to allow the retrieval of all rooms on no input

    manager.userAllowedCommand(socket.id, databasePopulation.commands.list.commandName, function(allowErr, allowed, user) {
      if (allowErr || !allowed) {
        return;
      }

      const itemList = [];
      const rooms = user.rooms;
      const partialName = data.partialName;

      if (user.team) {
        rooms.push('team');
      }

      for (let i = 0; i < rooms.length; i++) {
        const room = rooms[i];

        if (!shouldBeHidden(room, socket.id) && (!data.partialName || room.indexOf(partialName) === 0)) {
          itemList.push(room);
        }
      }

      if (itemList.length === 1) {
        socket.emit('matchFound', { matchedName: itemList[0] });
      } else {
        socket.emit('list', {
          itemList: {
            itemList: itemList,
            keepInput: false,
            replacePhrase: true,
          },
        });
      }
    });
  });

  socket.on('matchPartialRoom', function(data) {
    // data.partialName is not checked if it set, to allow the retrieval of all rooms on no input

    manager.userAllowedCommand(socket.id, databasePopulation.commands.list.commandName, function(allowErr, allowed, user) {
      if (allowErr || !allowed) {
        return;
      }

      dbConnector.matchPartialRoom(data.partialName, user, function(err, rooms) {
        if (err) {
          return;
        }

        const itemList = [];
        const roomKeys = Object.keys(rooms);

        for (let i = 0; i < roomKeys.length; i++) {
          itemList.push(rooms[roomKeys[i]].roomName);
        }

        if (itemList.length === 1) {
          socket.emit('matchFound', { matchedName: itemList[0] });
        } else {
          socket.emit('list', {
            itemList: {
              itemList: itemList,
              keepInput: false,
              replacePhrase: true,
            },
          });
        }
      });
    });
  });

  socket.on('inviteToRoom', function(data) {
    if (!objectValidator.isValidData(data, { user: { userName: true }, room: { roomName: true } })) {
      return;
    }

    manager.userAllowedCommand(socket.id, databasePopulation.commands.inviteroom.commandName, function(allowErr, allowed, user) {
      if (allowErr || !allowed) {
        return;
      }

      const userName = data.user.userName;
      const roomName = data.room.roomName;

      dbConnector.getUser(userName, function(userErr, invitedUser) {
        if (userErr || invitedUser === null) {
          return;
        } else if (invitedUser.rooms.indexOf(roomName) > -1) {
          messenger.sendSelfMsg({
            socket: socket,
            message: {
              text: ['The user is already following the room'],
              text_se: ['Användaren följer redan rummet'],
            },
          });

          return;
        }

        const invitation = {
          itemName: roomName,
          time: new Date(),
          invitationType: 'room',
          sender: user.userName,
        };

        dbConnector.addInvitationToList(userName, invitation, function(invErr, list) {
          if (invErr || list !== null) {
            if (list || invErr.code === 11000) {
              messenger.sendSelfMsg({
                socket: socket,
                message: {
                  text: ['You have already sent an invite to the user'],
                  text_se: ['Ni har redan skickat en inbjudan till användaren'],
                },
              });
            } else {
              logger.sendSocketErrorMsg({
                socket: socket,
                code: logger.ErrorCodes.general,
                text: ['Failed to send the invite'],
                text_se: ['Misslyckades med att skicka inbjudan'],
                err: invErr,
              });
            }

            return;
          }

          messenger.sendSelfMsg({
            socket: socket,
            message: {
              text: ['Sent an invitation to the user'],
              text_se: ['Skickade en inbjudan till användaren'],
            },
          });
        });
      });
    });
  });

  socket.on('roomAnswer', function(data) {
    if (!objectValidator.isValidData(data, { accepted: true, invitation: { itemName: true, sender: true, invitationType: true } })) {
      return;
    }

    manager.userAllowedCommand(socket.id, databasePopulation.commands.invitations.commandName, function(allowErr, allowed, allowedUser) {
      if (allowErr || !allowed) {
        return;
      }

      const invitation = data.invitation;
      const userName = allowedUser.userName;
      const roomName = invitation.itemName;
      invitation.time = new Date();

      if (data.accepted) {
        dbConnector.addRoomToUser(userName, roomName, function(roomErr) {
          if (roomErr) {
            logger.sendErrorMsg({
              code: logger.ErrorCodes.db,
              text: ['Failed to follow ' + roomName],
              err: roomErr,
            });

            return;
          }

          followRoom({ socket: socket, userName: userName, newRoom: { roomName: roomName } });
          dbConnector.removeInvitationFromList(userName, roomName, invitation.invitationType, function(remErr) {
            if (remErr) {
              return;
            }
          });
        });
      } else {
        dbConnector.removeInvitationFromList(userName, invitation.itemName, invitation.invitationType, function(err, list) {
          if (err || list === null) {
            messenger.sendSelfMsg({
              socket: socket,
              message: {
                text: ['Failed to decline invitation'],
                text_se: ['Misslyckades med att avböja inbjudan'],
              },
            });

            return;
          }

          messenger.sendSelfMsg({
            socket: socket,
            message: {
              text: ['Successfully declined invitation'],
              text_se: ['Lyckades avböja inbjudan'],
            },
          });
        });
      }
    });
  });
}

exports.handle = handle;
