import asyncio
import json
import logging
import websockets
import os

logging.basicConfig(level=logging.INFO)

# rooms = {
#   room_id: {
#     "clients": { user_id: websocket, ... },
#     "order": [user_id1, user_id2, ...]
#   }
# }
rooms = {}


async def send_json(ws, payload):
    try:
        await ws.send(json.dumps(payload))
    except Exception as e:
        logging.warning(f"send_json failed: {e}")


async def broadcast_room_state(room_id):
    room = rooms.get(room_id)
    if not room:
        return

    payload = {
        "type": "room_state",
        "peers": list(room["clients"].keys()),
        "order": room["order"],
    }

    for ws in room["clients"].values():
        await send_json(ws, payload)


def normalize_order(room_id, proposed_order):
    room = rooms[room_id]
    current_peers = list(room["clients"].keys())

    # Keep only IDs still in room
    cleaned = [uid for uid in proposed_order if uid in room["clients"]]

    # Append missing peers so nobody disappears
    for uid in current_peers:
        if uid not in cleaned:
            cleaned.append(uid)

    return cleaned


async def handler(websocket, *args):
    user_id = str(id(websocket))
    current_room = None

    try:
        async for message in websocket:
            data = json.loads(message)
            msg_type = data.get("type")

            if msg_type == "join":
                room_id = data.get("room")
                if not room_id:
                    continue

                current_room = room_id
                if room_id not in rooms:
                    rooms[room_id] = {
                        "clients": {},
                        "order": []
                    }

                room = rooms[room_id]
                room["clients"][user_id] = websocket
                if user_id not in room["order"]:
                    room["order"].append(user_id)

                logging.info(f"User {user_id} joined room {room_id}")

                await send_json(websocket, {
                    "type": "joined",
                    "selfId": user_id,
                    "order": room["order"],
                    "peers": list(room["clients"].keys()),
                })

                # Notify existing peers
                for uid, client in room["clients"].items():
                    if client != websocket:
                        await send_json(client, {
                            "type": "user_joined",
                            "userId": user_id
                        })

                await broadcast_room_state(room_id)

            elif msg_type == "leave":
                # Optional explicit leave from browser
                if current_room and current_room in rooms:
                    room = rooms[current_room]
                    if user_id in room["clients"]:
                        del room["clients"][user_id]
                    room["order"] = [
                        uid for uid in room["order"] if uid != user_id]

                    if not room["clients"]:
                        del rooms[current_room]
                    else:
                        await broadcast_room_state(current_room)
                current_room = None

            elif current_room and msg_type == "set_chain":
                room = rooms.get(current_room)
                if not room:
                    continue

                proposed_order = data.get("order", [])
                if not isinstance(proposed_order, list):
                    continue

                room["order"] = normalize_order(current_room, proposed_order)
                logging.info(f"Room {current_room} new chain: {room['order']}")
                await broadcast_room_state(current_room)

            elif current_room and msg_type == "signal_chunk":
                # Route ONLY to next node in chain
                room = rooms.get(current_room)
                if not room:
                    continue

                order = room["order"]
                if user_id not in order:
                    continue

                idx = order.index(user_id)
                if idx + 1 >= len(order):
                    # Last node in pipeline: nowhere to send
                    continue

                next_user_id = order[idx + 1]
                target_ws = room["clients"].get(next_user_id)
                if not target_ws:
                    continue

                data["from"] = user_id
                await send_json(target_ws, data)

            elif current_room:
                room = rooms.get(current_room)
                if not room:
                    continue

                data["from"] = user_id
                for uid, client in room["clients"].items():
                    if client != websocket:
                        await send_json(client, data)

    except websockets.exceptions.ConnectionClosed:
        logging.info(f"User {user_id} disconnected")

    finally:
        if current_room and current_room in rooms:
            room = rooms[current_room]

            if user_id in room["clients"]:
                del room["clients"][user_id]
            room["order"] = [uid for uid in room["order"] if uid != user_id]

            if not room["clients"]:
                del rooms[current_room]
            else:
                for client in room["clients"].values():
                    await send_json(client, {"type": "user_left", "userId": user_id})
                await broadcast_room_state(current_room)


async def main():
    port = int(os.environ.get("PORT", 8081))
    logging.info(f"Starting LabLink WebSocket server on port {port}")
    async with websockets.serve(handler, "0.0.0.0", port):
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
