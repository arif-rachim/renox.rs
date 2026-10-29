export const guard = { action: "order.read" };
export const ws = {
  async open({ conn, params, realtime }) { await realtime.subscribe(conn, `room:${params.room}`); },
  async message({ params, data, realtime }) { await realtime.publish(`room:${params.room}`, { fragment: "partials/order-row", data: { text: String(data) } }); },
};
