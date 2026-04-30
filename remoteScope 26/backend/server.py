import asyncio
import json
import logging
import websockets
import os

logging.basicConfig(level=logging.INFO)

# Room management: { "room_id": set(websocket1, websocket2, ...) }
rooms = {}

async def handler(websocket, *args):
    user_id = str(id(websocket))
    current_room = None

    try:
        async for message in websocket:
            data = json.loads(message)
            msg_type = data.get('type')
            
            if msg_type == 'join':
                room_id = data.get('room')
                if not room_id:
                    continue
                current_room = room_id
                if room_id not in rooms:
                    rooms[room_id] = set()
                rooms[room_id].add(websocket)
                logging.info(f"User {user_id} joined room {room_id}")
                
                # Notify others in room
                for client in rooms[room_id]:
                    if client != websocket:
                        await client.send(json.dumps({'type': 'user_joined', 'userId': user_id}))

            elif current_room:
                # Add sender context and relay the message
                data['from'] = user_id
                # Relay strictly to other clients in the same room
                for client in rooms[current_room]:
                    if client != websocket:
                        await client.send(json.dumps(data))
                        
    except websockets.exceptions.ConnectionClosed:
        logging.info(f"User {user_id} disconnected")
    finally:
        if current_room and current_room in rooms:
            if websocket in rooms[current_room]:
                rooms[current_room].remove(websocket)
            if len(rooms[current_room]) == 0:
                del rooms[current_room]
            else:
                for client in rooms[current_room]:
                    await client.send(json.dumps({'type': 'user_left', 'userId': user_id}))

async def main():
    port = int(os.environ.get("PORT", 8080))
    logging.info(f"Starting LabLink WebSocket server on port {port}")
    async with websockets.serve(handler, "0.0.0.0", port):
        await asyncio.Future()  # run forever

if __name__ == "__main__":
    asyncio.run(main())
