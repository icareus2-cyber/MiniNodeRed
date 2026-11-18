// Ports on the chip's own USB (Espressif VID 0x303A, TinyUSB CDC) only pass data
// while DTR is on, and RTS does not reset them. 0x1001 (USB-Serial-JTAG) emulates
// the classic DTR/RTS reset circuit, so it is left alone.
const ESPRESSIF_VID = 0x303a;
const USB_JTAG_PID = 0x1001;

const hex = (v) => (v === undefined || v === null ? NaN : parseInt(v, 16));
const keepsDtr = (vid, pid) => vid === ESPRESSIF_VID && pid !== USB_JTAG_PID;
const portKeepsDtr = (p) => !!p && keepsDtr(hex(p.vendorId), hex(p.productId));

module.exports = { ESPRESSIF_VID, keepsDtr, portKeepsDtr };
