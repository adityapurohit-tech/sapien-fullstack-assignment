# Full Stack Developer Assignment: Sapien Robotics

Aditya Purohit's submission. Each question has its own folder with a README that explains how to run it.

| | Folder | What is in it |
|---|---|---|
| **Question 1:** Multiplayer drawing and guessing game | [q1-scribble-room/](q1-scribble-room/) | The game (Node.js and WebSockets, no build step), 20 automated server tests, a three-browser end-to-end check, a load test, and the [note](q1-scribble-room/NOTE.md) on canvas sync, latency and ordering, server restarts and capacity |
| **Question 2:** Music streaming with "Listen Together" rooms | [q2-listen-together/](q2-listen-together/) | The [design doc (PDF)](q2-listen-together/docs/Q2_Design_Doc.pdf), the [architecture diagram](q2-listen-together/docs/architecture_diagram.png), the [sequence diagram for "host presses pause in a room of 5,000 listeners"](q2-listen-together/docs/sequence_pause_5000.png), and a runnable proof of concept of the room-sync design with tests and benchmarks |

## Run them

Both need Node.js 20 or newer.

```bash
# Question 1: the game, at http://localhost:4100
cd q1-scribble-room
npm install && npm start

# Question 2: the Listen Together proof of concept, at http://localhost:3000
cd q2-listen-together/poc
npm install && npm start
```

The two use different ports, so they can run at the same time. To play the game, create a room and open the invite link in two or more other browser tabs or windows.

## Tests

```bash
cd q1-scribble-room && npm test        # 20 server tests
cd q2-listen-together/poc && npm test  # 21 tests
```

The project was built with the help of an AI assistant (Claude), as the brief allows. I can talk through any part of it.
