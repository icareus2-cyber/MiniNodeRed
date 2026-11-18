# Microflow

A local IDE for ESP8266 and ESP32 boards. It is not a Node-RED runtime: you design the program as a visual flow, the IDE compiles it to native Arduino C++, uploads it (USB or remotely), and helps you debug it over MQTT. Once development is done, the chip runs on its own, with no PC, editor or JavaScript on the board.

JavaScript runs the IDE, the MQTT tools and an optional PC simulator. SQLite stores flows, revisions, test cases and results, devices, build history and the project's remote-update key. A typical flow uses about 25 % of a NodeMCU's flash and 36 % of its RAM.

## Build profiles

|                                                                           | Debug (IDE tools) | Release (standalone)                                                                                                        |
| ------------------------------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Flow logic, GPIO, timers, Radio in/out nodes                              | ✓                 | ✓                                                                                                                           |
| Telemetry, debug nodes over MQTT, inject from the IDE, USB status (`mf?`) | ✓                 | ✗ removed                                                                                                                   |
| Remote update (if enabled) and ping to confirm builds                     | ✓                 | ✓                                                                                                                           |
| WiFi                                                                      | always            | only if the flow has MQTT nodes or remote update is on; otherwise the radio is switched off and the chip runs fully offline |

Choose **Build** and **Remote update** in the Device panel. The firmware header and the upload window show which profile a build uses. The build ID changes with the profile, so Devices can show what each board runs.

## Run

Requires Node.js 20 or later.

```powershell
npm install
npm start
```

Open <http://127.0.0.1:3000>. The server binds to loopback. Set `PORT` for a different port and `DB_PATH` to change the SQLite location (default `data/microflow.sqlite`). Existing databases are migrated automatically, and existing flows get their first revision.

## Accounts and login

Without any account Microflow works as before: one person on this PC, no login. Requests that arrive through a reverse proxy (a deployed server) are refused with HTTP 503 until the admin exists, so a server is never open by accident.

Create the admin before you deploy, either on this PC (click the round **MF** badge at the bottom of the left rail → *Create the admin*) or on the server:

```bash
npm run user -- add max --admin     # asks for the password twice
npm run user -- add bob             # a normal user
npm run user -- passwd bob          # new password, logs bob out everywhere
npm run user -- admin bob on|off
npm run user -- disable bob | enable bob
npm run user -- list
```

The first account is always an admin and receives the flows, deployments and settings made before accounts. Once an account exists, every page and API needs a login (`/login.html`). There is no sign-up: the admin adds users in **badge → Users…** (add, set password, make admin, disable, delete — deleting a user deletes their flows).

- **Own flows.** Each user sees and saves only their own flows, tests, deployments and settings (Ask AI keys, broker settings).
- **Shared examples.** An admin clicks **Share** in Saved flows to show a flow to everyone. Others can open it read-only; **Save** makes their own copy and leaves the example unchanged.
- **Security.** Passwords are stored as salted scrypt hashes. The login cookie is HttpOnly and SameSite, and Secure behind HTTPS; the database keeps only a hash of the session token. Sessions last 14 days. Five wrong passwords lock that name (from that address) for a minute. Serve a deployed copy over HTTPS (e.g. Caddy), never plain HTTP.
- **Still shared by all users** of one server: the PC simulator, the console event stream, the serial port and USB devices, and the OTA keys. Accounts keep flows apart; they do not give each user a separate simulator.

## Build a flow

Click library nodes to add them, drag nodes to arrange them, and click an output port, then an input port, to connect them. Select a node to edit its label and properties. Select a node or link and press **Delete selected** (or the Delete key) to remove it. Save to store the flow in SQLite.

**Clear and undo:** **Clear** (top right of the canvas) removes every node and connection on the open tab. **↶ Undo** (or **Ctrl+Z** on the canvas) brings back what the last Clear or delete removed: deleted nodes and connections, a deleted flow tab or chip. The last 20 are kept until another flow is opened.

**Several nodes, copy and paste:** Ctrl+click (or Shift+click) adds a node to the selection or removes it, and dragging a box on empty canvas selects the nodes it touches (Ctrl/Shift + box adds to the selection). Dragging one selected node moves them all; Delete removes them all; a click on empty canvas clears the selection. **Ctrl+C** copies the selection, **Ctrl+X** cuts it, **Ctrl+V** pastes it 30 px below and right (or at the pointer, from the right-click menu), **Ctrl+D** duplicates it and **Ctrl+A** selects every node on the tab. Right-clicking the canvas or a node opens the same commands. Pasted nodes get new ids, onto the open tab, with the wires between them; a variable name already in use gets a new default (`SW1` → `SW3`), and pasted Logic inputs and C/C++ code that use it follow. Copied nodes also go on the system clipboard as JSON, so another Microflow window can paste them.

In **Saved flows** (rail ▤), select several flows to delete them together. Click a row or its checkbox, Shift-click to select a range, or press and drag across rows. Ctrl+A selects all, and **Delete selected** (or the Delete key) removes them after one confirmation. Their tests and history are deleted with them, in a single SQLite transaction.

**Flow tabs:** a flow can span several tabs along the top of the canvas. **+** at the end of the tabs adds a tab, double-clicking a tab renames it, and **×** on the open tab deletes it with its nodes. All tabs belong to the same flow: they are saved, compiled and uploaded together as one program for one board, and the 64-node limit counts all tabs. Nodes on different tabs connect through **Link out** and **Link in** nodes with the same link name; a link node shows which tab it connects to, and its properties have buttons to jump there. In Saved flows, **Add as tab** copies another saved flow into a new tab of the open flow.

**Chips (multi-chip development):** the **CHIPS** row behind the flow tabs holds one tab per chip (board) of the project. **+ Add chip** adds a chip with its own empty flow tab; the first time, the project's existing tabs become **Chip 1** with the Device panel's settings. Each chip keeps its own **board, Device ID and serial port**: switching chips switches the Device panel, and its title shows which chip it is for. Compile, upload, the board check, the pin map, the PC simulator and Real board tests all work on the chip on screen, from that chip's flow tabs only, so two chips may use the same GPIO. Double-click a chip to rename it; **×** deletes it with its flows. Chips talk to each other through **Radio in / out** nodes (MQTT, local MQTT, ESP-NOW or I2C): a Radio in topic field suggests the topics the project's Radio out nodes send, with the chip that sends each, and vice versa. Link in / Link out stay within one chip. **▶ Simulate** with two or more chips runs every chip at once on this PC with a **built-in MQTT** (no broker, no upload): a Radio out on one chip reaches the Radio in boxes of the others (MQTT topics with + and # wildcards, retained messages), and ESP-NOW broadcasts reach every chip. Each chip simulates under its own Device ID (blank ones become `sim`, `sim2`, `sim3`…; two chips may not share one), console lines start with the chip's name, and the virtual pins and LCD show the chip on screen (switch chips to see the others). A chip's Local MQTT Radio out also reaches the MQTT Radio in boxes of the other chips (as if they connected to its broker; on real boards set their broker URL to that board's IP), while a Local MQTT Radio in only hears its own chip; I2C stays within each chip in the simulator. Radio in boxes that no Radio out can reach are reported as warnings when the simulation starts; the MQTT test tools and outside MQTT clients do not see the built-in MQTT (simulate one chip to use the real broker). Limits (64 nodes, 128 connections, 16 tabs) apply per chip; a project holds up to 8 chips.

Each save that changes the flow keeps a revision (the latest 50). **History** lists revisions; restoring one loads it onto the canvas until you save. Import/export uses portable JSON.

| Group    | Node                | Behaviour                                                                                                                                                                                                                                                                                                                                                              |
| -------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input    | Inject              | Repeats at an interval. With interval 0 it fires from ▶ or the MQTT topic `microflow/<device>/inject/<node id>`. A non-empty MQTT payload overrides the configured payload. A new Inject starts with payload `12345ABCDE`, every 1000 ms.                                                                                                                                                                                            |
|          | Radio in            | Receives from other boards. **Protocol** in Properties: **MQTT** (subscribe; `+`/`#` wildcards), **ESP-NOW** (ESP32 boards nearby, no router; the topic filters messages), **I2C** (controller polls a peripheral's address / peripheral receives the controller's writes).                                                                                            |
|          | Terminal            | Like Inject, but typed: `<command> <data>` in any terminal (USB serial, the test terminal, the board page) sends `<data>` into the flow. Works on every board.                                                                                                                                                                                                         |
|          | Web in              | JSON posted to `http://<board IP>/api/<name>` enters the flow; the reply is the JSON of all Web out values. Needs WiFi.                                                                                                                                                                                                                                                |
|          | BLE in              | Receives values from BLE out nodes on the same link name on nearby ESP32 boards (no pairing). ESP32 only; never fires in the simulator.                                                                                                                                                                                                                                |
|          | GPIO input (change) | Emits `0`/`1` when a debounced digital input changes. Input mode: internal pull-up (button to GND, pressed = 0), internal pull-down (button to 3.3 V, pressed = 1; ESP32 and BW16) or floating. *At start-up* can also send the level once, so a GPIO output follows the input from power-on.                                                                                                                                                                                                                                                                                            |
|          | Pulse train         | Pulse generator: sends `1`, waits the ON time, sends `0`, waits the OFF time; repeats forever or N times, optionally after a start delay.                                                                                                                                                                                                                              |
|          | Input device        | A sensor read at an interval; choose the **Device**: temperature sensor, voltmeter, gyroscope / accelerometer, oscilloscope capture or camera. See [Input and Output devices](#input-and-output-devices-sensors-and-motors).                                                                                                                                           |
|          | Analog sample       | Reads the ADC at an interval (ESP8266 A0 = GPIO 17, 0–1023; ESP32 ADC1 pins, 0–4095). **Resolution**: the board's own, or 8 (0–255), 10 (0–1023) or 12 bits (0–4095); the simulator's slider follows it.                                                                                                                                                                                                                                                                                  |
| Logic    | Threshold           | Passes numbers ≥ minimum.                                                                                                                                                                                                                                                                                                                                              |
|          | Compare             | `<`, `≤`, `>`, `≥` (numeric); `=`, `≠` (numeric if both sides are numbers, else text); `contains`.                                                                                                                                                                                                                                                                     |
|          | Map range           | Linear scale, e.g. ADC 0–1023 → 0–100 %, with decimals and optional clamping.                                                                                                                                                                                                                                                                                          |
|          | Throttle            | Drops messages arriving sooner than the minimum gap.                                                                                                                                                                                                                                                                                                                   |
|          | Template            | Replaces the payload; `{{payload}}` inserts the incoming value.                                                                                                                                                                                                                                                                                                        |
|          | Logic               | Gates (AND, OR, XOR, NAND, NOR, XNOR, NOT), flip-flops (SR latch, toggle, D) and timers (on-delay, off-delay, pulse) on on/off values. See [Logic node](#logic-node-gates-flip-flops-and-timers).                                                                                                                                                                      |
|          | Timer               | Started by a rising edge (off → on) that stays on for the trigger pulse width (default 1 ms): waits **T1** (default 0 s), sends `1`, keeps it for **T2** (default 1 s), sends `0`. Triggers while it runs are ignored, not queued. **Set** / **Reset** (Properties: choose which connected input is which, e.g. two GPIO input boxes, listed with their GPIO pin; Set blank = any input that is not Reset), each triggered on a **rising** (off → on) or **falling** edge (on → off, e.g. a button to GND with a pull-up): a Reset edge whose new level stays for the trigger pulse width stops the timer and its output goes off (`0` during T2, nothing during T1); while Reset is on, Set is ignored. The box shows T1 / ON / done, and each trigger is reported in the console (on a board: USB serial, and the IDE with a debug build). |
|          | Link in / out       | A value sent into a Link out comes out of every Link in with the same link name, on any flow tab. Link out has no output; Link in has no input. They add no firmware code of their own.                                                                                                                                                                                |
| Code     | C/C++               | Your own C/C++ for calculations and decisions: inputs as typed variables, `send(x)` out, optional setup/loop; no hardware access. See [C/C++ node](#cc-node-your-own-code).                                                                                                                                                                                            |
| Hardware | GPIO input / output | **GPIO input** reads the pin by itself every *Read every (ms)* and sends its level (`0`/`1`); **GPIO output** writes LOW for `0`/`false` and HIGH for anything else. Each has one connection only (GPIO input: an output dot; GPIO output: an input dot); the other end is the pin on the circuit.                                                                                                                                                                                                                                                                                           |
|          | PWM out             | Writes duty 0–255 (clamped).                                                                                                                                                                                                                                                                                                                                           |
|          | Pulse               | One-shot pulse: each message drives a pin active (HIGH or LOW) for the width, then back; sends `1` at the start and `0` at the end. Can take the width from a numeric payload; retrigger restarts or is ignored. Non-blocking.                                                                                                                                         |
| Output   | Radio out           | Sends to other boards: **MQTT** (publish, QoS 0, optionally retained), **ESP-NOW** (broadcast topic + payload, up to about 180 bytes), **I2C** (controller writes to an address / peripheral sets the reply to the controller's polls).                                                                                                                                |
|          | BLE out             | Broadcasts the payload (up to 20 bytes) over Bluetooth LE to boards with a BLE in node on the same link name. ESP32 only; the simulator only logs it.                                                                                                                                                                                                                  |
|          | Web out             | Publishes the payload as a JSON variable at `GET http://<board IP>/api/<name>` (all values: `GET /api`). Needs WiFi.                                                                                                                                                                                                                                                   |
|          | Output device       | Moves a **servo** or a **stepper motor** from the numbers it receives (angle, position, distance, steps or speed); sends on where it stopped. Or shows values on an **I2C display**: SSD1306 OLED (128×64 / 128×32, 0x3C) or a 16×2 / 20×4 character LCD with a PCF8574 backpack (0x27): SDA / SCL pins, address, **Line**, **Text** with `{{payload}}`, text size (OLED) and clear line / screen. Boxes with the same address share one screen, each writing its own line; the I2C bus is shared with gyroscopes and Radio I2C (same SDA / SCL). See [Input and Output devices](#input-and-output-devices-sensors-and-motors).                                                                                                                                            |
|          | *(servo view)*      | In the PC simulation (and with a real board over USB) a servo's box shows a small **robot arm** on a servo that turns to the angle at the servo's speed, with the angle and the pulse width (µs) it means; a continuous-rotation servo (input: speed) spins. Peripheral boxes driving a servo show it too.
|          | Debug               | Prints to serial and publishes to `microflow/<device>/debug/<node id>`.                                                                                                                                                                                                                                                                                                |
|          | Status              | An I2C display (16×2 / 20×4 LCD with a PCF8574 backpack, or an SSD1306 OLED) for the status of other nodes: tick **Show on the Status display** in any node's Properties and it gets a line, e.g. `GPIO 13 HIGH`. No wires; one per board. See [Status display](#status-display-the-state-of-any-node-on-an-i2c-lcd).                                                    |
| Test     | Function generator  | Test signal: every sample interval it sends offset + amplitude × a **sine**, **square** (with duty cycle), **triangle** or **sawtooth** wave (−1…1) at the chosen frequency (up to 50 Hz, at least two samples per period). Feed an Oscilloscope, PWM out (amplitude 127.5, offset 127.5 = 0–255), Threshold or C/C++. Runs on the board and in the PC simulation.
|          | *(Switch, Push button)* | No longer in the node library: a **GPIO input** box has **PUSH** and **SWITCH** while simulating or emulating, and reads the real button on the circuit. Flows that already contain Switch / Push button boxes keep working.
|          | Oscilloscope        | Plots incoming values over a time window (1–120 s) on the box; `on`/`true` = 1, `off`/`false` = 0. On a board it needs a debug build with telemetry.                                                                                                                                                                                                                   |
|          | Screen              | Shows the picture it receives on its box (Small / Medium / Large): a Camera node's output `{"image": …}`, a picture address (`http://…`, `/api/…`) or a `data:image/…` URL; click it for full size. **Simulation only**: works with ▶ Simulate and adds nothing to the firmware (a warning says so).                                                                   |

**Analog and on/off signals:** analog values (Analog sample, Input device sensors) cannot be wired straight into Logic or Timer: put a **Threshold** or **Compare** between them to turn the value into on/off. In the other direction, Logic and Timer outputs (0/1) cannot go straight into analog outputs (PWM out, Output device): put a **Map range** between them (e.g. 0–1 → 0–255). The editor refuses such a wire with a message; one in an older or imported flow is drawn red and stops the build until you delete it.

Flows are acyclic (also through Link out / Link in), with up to 64 nodes, 128 connections and 16 tabs. Input nodes cannot receive connections.

**❓ Help example** (at the bottom of Node properties) shows a small example flow for the selected node on the canvas, in place of your flow, always on one screen: e.g. Timer shows a SET and a RESET Push button, the Timer, an LED on GPIO 2 and Debug. A floating help window (drag it by its title bar, – folds it) says what the example does and what to try, and **Run with** chooses how: **Simulate on this PC** (nothing to upload), **Real board (monitor)** (upload the example first) or **Real board + PC inputs (USB)**; ▶ Start and ■ Stop run it. Select and change the example's boxes freely: it is never saved. **⧉ Copy into my flow** goes back to your flow with the example's boxes pasted onto your tab; **✕ Back to my flow** (or Esc in the window) brings your flow back exactly as it was (unsaved edits, tab, chip and split screen included). While the example is shown, Save, Saved flows, Import, History, Tests and Split wait.

The former **Examples** list in Saved flows is gone (the help examples replace it); copies of examples added earlier stay in your saved flows until you delete them there. The `examples/*.json` files remain in the project (used by the automated tests), and their flows can still be read below.

### Logic node: gates, flip-flops and timers

One **Logic** node (LOGIC group) does the work of a PLC function block; choose its **Function**. Inputs are on for `1`, `true`, `on`, `yes` or any non-zero number, off for anything else. The output is `1` or `0`, and its variable type in C/C++ nodes is `bool`.

| Function                      | Output                                                                                                                            |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| AND, OR, XOR, NAND, NOR, XNOR | Combines every connected input, each with its last state (inputs not heard yet count as off). XOR is 1 when an odd number are on. |
| NOT                           | The opposite of its input.                                                                                                        |
| SR latch                      | **Set** turns it on, **Reset** off; it holds in between. **Both on**: reset wins (or set wins).                                   |
| Toggle flip-flop (T)          | Each 0→1 of an input flips it.                                                                                                    |
| D flip-flop                   | On each 0→1 of **Clock**, it takes the state of **Data**.                                                                         |
| On-delay timer (TON)          | 1 once the input has been on for **Time** ms; 0 as soon as the input goes off.                                                    |
| Off-delay timer (TOF)         | 1 as soon as the input is on; 0 **Time** ms after it goes off (on again in between cancels that).                                 |
| Pulse timer (TP)              | Each 0→1 gives a 1 for **Time** ms; inputs during the pulse change nothing.                                                       |

Gates and flip-flops send when the output changes (**Send output**: or on every input); timers send when it changes. Set, Reset, Data and Clock are chosen from the connected inputs, by the variable names on their boxes (the board check reports one that is missing or not connected). The node knows which input sent each value, in the firmware as in the simulation, which run the same rules. Lesson **11 · Logic** shows a gate, a latch, a toggle and two timers, with tests.

### Counter: count, reset and three pulse outputs

The **Counter** node (LOGIC group) has two inputs and three outputs.

- **Count** input: each rising edge (off → on, e.g. a button press) adds 1. *Count on* can also be the falling edge or every message.
- **Reset** input: a value that is on sets the count back to 0; while Reset is on, counting stops. Choose which connected input is Count and which is Reset in Properties (as for the Timer); blank Count means any input that is not Reset.
- **Outputs 1, 2, 3**: the three numbered dots on the right of the box. Each output has its own preset (default 3, 5 and 10). When the count reaches it, that output sends a pulse: `1`, then `0` after the pulse width (default 500 ms).
- **After the highest preset**: keep counting (the outputs stay quiet), or start again at 0 so the pulses repeat.

The count shows on the box while simulating (and on USB serial on a board). To wire an output, click its numbered dot, then the input of the next box. The same behaviour runs in the PC simulation and on the board. ❓ Help example shows it with two buttons and three LEDs.

### Input and Output devices: sensors and motors

Two nodes cover common add-on hardware. Put one on the canvas and choose its **Device** in Properties: the fields, the pin guide, the default variable name and the wiring help below the fields follow the device.

**Input device** (INPUT group) reads a sensor every **Read every** ms and sends the reading:

| Device                      | What it sends                                                                                                                                       | Wiring and notes                                                                                                                                              |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Temperature sensor          | Temperature in °C or °F. DHT22 / DHT11 can send humidity too (`{"temperature":…,"humidity":…}`).                                                    | **DS18B20** (1-Wire, 4.7 kΩ pull-up), **DHT22 / DHT11** (10 kΩ pull-up), **NTC thermistor** (beta, R25 and series resistor), **LM35**, **TMP36** (analog).    |
| Voltmeter                   | Volts, averaged over N readings.                                                                                                                    | Analog pin; for more than 3.3 V a divider (R1 top, R2 bottom) and an optional calibration factor. ESP32 boards read calibrated millivolts.                    |
| Gyroscope / accelerometer   | MPU-6050: all values as JSON (`ax ay az` in g, `gx gy gz` in °/s, `pitch roll` in °) or one of them.                                                | I2C (SDA, SCL; address 0x68 or 0x69); ranges; zeroes the gyro at power-up. Shares the bus with Radio I2C as controller.                                       |
| Oscilloscope (fast capture) | A burst of samples at up to 20 000/s: `{"min","max","avg","vpp","hz"}` (frequency of a repeating signal) or all samples as a JSON array (up to 80). | Analog pin; raw ADC values. The board pauses while it captures (at most 250 ms).                                                                              |
| Image sensor (camera)       | Brightness (0–255) and/or motion (% of the picture changed since the last one).                                                                     | Camera boards: **AI-Thinker ESP32-CAM** or **Freenove ESP32-S3 WROOM CAM** (choose it as the board); 160 × 120 grey pictures. The picture itself is not sent. |

**Output device** (OUTPUT group) drives a motor:

- **Servo motor:** the input is an angle, a position (0–100 %), a pulse width (µs) or, for a continuous-rotation servo, a speed (−100…100 %). Set the angle range and the pulses at 0° and full range for your servo, a start angle, and optionally a turn speed (°/s). It sends the angle on when the servo has got there. ESP32 boards use the LEDC hardware (cores 2.x and 3.x, up to 6 servos), ESP8266 boards the core's Servo library.
- **Stepper motor:** a STEP / DIR driver (A4988, DRV8825, TMC2208…, with optional ENABLE) or a ULN2003 board with a 28BYJ-48. The input is an angle, a distance (mm, with the travel per revolution) or steps, either to move by or to go to, or a speed in RPM to run at. Moves accelerate to the top speed and slow down to stop on target; the node sends the position (in the input's unit) when a move is done. `stop` slows down and stops, `zero` makes the present position 0. **When stopped** can release the motor (ENABLE pin, or the ULN2003 coils off). At most 10 000 steps per second.

In the PC simulator the sensors give made-up readings (analog ones follow the virtual pin's slider) and the motors take as long as they would on the board, logging what they do in the console. DS18B20 and DHT sensors use Arduino libraries (OneWire, DallasTemperature, DHT sensor library), which Microflow installs with arduino-cli on the first compile; the other devices need none. The example **Devices · greenhouse** has a temperature-controlled vent flap, a battery voltmeter, a tilt sensor and a turntable, with a test.

### Status display: the state of any node on an I2C LCD

The **Status** node (OUTPUT group) is an I2C display that shows how other nodes stand, one line per node. It has no wires: select any node and tick **Show on the Status display** in its Properties (the note beside it says which line it gets, and the box shows a small ☰). The line changes when that node handles a new value and stays as it is until then, so the display always shows the latest state.

| Node                                         | Its line reads                     |
| -------------------------------------------- | ---------------------------------- |
| GPIO output, GPIO input, GPIO input (change) | `GPIO 13 HIGH` / `GPIO 13 LOW`     |
| PWM out                                      | `GPIO 5 PWM 128`                   |
| Pulse                                        | `GPIO 2 ON` / `GPIO 2 OFF`         |
| Logic, Timer, Pulse train                    | `TIMER1 ON` / `TIMER1 OFF`         |
| Counter                                      | `COUNT1 out2 ON`: the output that last sent |
| Anything else (sensors, Map range, C/C++…)   | variable name and value: `TEMP1 21.5` |

Before a node has handled a value its line shows `GPIO 13 -`. Lines are in the order of the nodes in the flow. With more ticked nodes than the display has lines, it pages through them (**Next page every**, default 3 s). The board redraws only the lines that changed, at most 10 times a second.

Choose the **Display** (LCD 16×2 or 20×4 with a PCF8574 backpack, OLED 128×64 or 128×32), the **SDA / SCL** pins and the **I2C address** (usual: LCD 0x27, sometimes 0x3F; OLED 0x3C). Wiring: VCC to 3.3 V (or 5 V for most LCD backpacks), GND, SDA and SCL. The libraries (LiquidCrystal I2C, or Adafruit SSD1306 + GFX) are installed on the first build. A board has one Status node. It shares the I2C bus with Output device displays and gyroscopes (same SDA / SCL), but needs an address of its own. While simulating (or emulating with the real board over USB), the Status box draws the display as the board shows it. **❓ Help example** shows a switch and an LED on one LCD.

### Camera node: still pictures as PNG files (Freenove ESP32-S3 WROOM CAM)

**Camera** (HARDWARE group) takes a still picture on each rising edge (off → on) of its input: a push button, a switch, a Logic or a Timer node. It works on the **Freenove ESP32-S3 WROOM CAM** board only (greyed out in the palette for other boards).

- **Properties:** the **Image sensor** fitted (OV2640, OV3660 or OV5640: the board reports on USB serial if another one answers), **Resolution** (**Auto**, or QVGA 320 × 240 … QSXGA 2560 × 1920), **Colour** (24-bit RGB) or grey (8-bit, a third of the size), brightness, contrast and saturation (−2 … 2), white balance, mirror and flip.
- **On the board:** the latest picture stays in the PSRAM and is served as a PNG file at `http://<board IP>/camera/<node id>.png`. The PNG is made while it is sent, so it needs no memory beyond the picture; sending a large one takes a few seconds, during which the flow waits. The node sends `{"image": "<that address>", "width": …, "height": …, "shot": n}`.
- **On the PC:** with a debug build (or ▶ Simulate, which makes a test picture), Microflow fetches each picture and saves it as a PNG file in the `captures` folder of the Microflow folder. **🖼** on the node opens the latest picture in a floating window that stays on top of other windows and can be dragged to any monitor (Chrome and Edge; other browsers open a small pop-up window). It shows each new picture as it comes, with **Save PNG** and **Full size**.
- **Auto resolution** (the default): at power-up the board measures its free PSRAM and asks the sensor which one it is, then takes the largest picture both allow; if a size does not start, or later gives no picture, it steps down to the next one. It reports its choice on USB serial and, with a debug build, in the IDE with the first picture, e.g. `auto: UXGA 1600 x 1200 colour · module N16R8 · PSRAM 8.0 MB (7.7 MB free) · sensor 0x26`. The N16R8 and N8R8 versions of the board both have 8 MB PSRAM (the first number is flash, which does not hold pictures), so both take the same pictures:

  | Sensor | Colour (2 bytes per pixel) | Grey (1 byte per pixel)    |
  | ------ | -------------------------- | -------------------------- |
  | OV2640 | UXGA 1600 × 1200 (3.7 MB)  | UXGA 1600 × 1200           |
  | OV3660 | QXGA 2048 × 1536 (6.0 MB)  | QXGA 2048 × 1536           |
  | OV5640 | QXGA 2048 × 1536 (6.0 MB)  | QSXGA 2560 × 1920 (4.7 MB) |

  A fixed resolution larger than the sensor takes, or a QSXGA colour picture (9.4 MB), is reported as an error before compiling. Large pictures make large PNG files (UXGA colour about 5.5 MB) that take several seconds to send over Wi-Fi; choose a smaller resolution or Grey when speed matters more than detail.

- **Live video for focusing:** open `http://<board IP>/camera/live` in a browser (or **Live video (focus)** in the 🖼 window). It plays low-resolution video (property **Live video page**: QVGA, VGA or SVGA; **Off** removes it) with a **sharpness** number: turn the lens slowly until the number is highest, pointing the camera at something with fine detail such as printed text. While the video plays the board's flow pauses; it stops when the page is closed or after 5 minutes, and the camera goes back to still pictures (the last picture is dropped).
- **When it takes a picture:** only when its input changes from off to on. A second on (`1`) without an off (`0`) in between does nothing; the board then says so on USB serial. In a debug build, the terminal command `camera` takes a picture straight away. Serial commands sent without Enter (a terminal's "Send as text") run after 0.3 s.
- One Camera node per flow, and not together with an Input device Image sensor (one camera).

### Peripheral node: a device that acts when triggered

**Peripheral** (HARDWARE group) drives a common Arduino peripheral, chosen in **Peripheral**: a **servo motor**, a **stepper motor** (STEP / DIR driver or ULN2003 + 28BYJ-48) or an **MPU-6050 gyroscope / accelerometer**. Each time its **Trigger input** rises (off → on: a push button, a switch, a Logic or Timer node), it does one operation:

| Peripheral | Parameters (default)                     | On each trigger                                             | Sends                                   |
| ---------- | ---------------------------------------- | ----------------------------------------------------------- | --------------------------------------- |
| Servo      | Angle (90°), Speed (60 °/s; 0 = at once) | turns to the angle at the speed                             | the angle, once there                   |
| Stepper    | Turn by (90°, + / −), Speed (30 RPM)     | turns by the angle at the speed (with the acceleration set) | its position (°), when the turn is done |
| Gyroscope  | Readings to average (1)                  | takes a reading (the average of the readings)               | the reading (all as JSON, or one value) |

Each parameter is its default value, or comes from a connected input chosen by its variable name (**Angle: from**, …), so an analog input can set it: e.g. a knob on an Analog sample through **Map range** (0–4095 → 0–180°) as the servo's angle. The latest value received is kept until the next trigger. The trigger must be on / off: an analog trigger is refused (put a Threshold or Compare before it). In the firmware the parameters are a **C union**, one struct per kind, which you can see in **Preview firmware**:

```cpp
union MfPeripheralParams { MfServoParams servo; MfStepperParams stepper; MfGyroParams gyro; };
struct MfPeripheral { MfPeripheralKind kind; MfPeripheralParams p; bool level; };
MfPeripheral mfPeriph4;   // this node: mfPeriph4.p.servo.angle, mfPeriph4.p.servo.speed
```

The drivers, pins, I2C bus and checks are the same as the Input / Output device nodes'. The example **Peripheral · servo with a knob** turns a servo to a potentiometer's angle when GO is pressed, with a test.

### C/C++ node: your own code

The **C/C++** node (CODE group) runs C/C++ you write, inside the flow, for what the other nodes cannot express: calculations, decisions, counting, formatting. To keep programs simple, **it does not touch hardware**: pins, analog, PWM, Serial, WiFi and the radios belong to the other nodes (GPIO input/output, Analog sample, PWM out, Debug, Radio in/out, …), whose values you wire in and out. Special functions for more will be added later. Its Properties have four code boxes (**Open code editor** shows them in a large window):

| Box                     | Runs                                 | Notes                                                                                   |
| ----------------------- | ------------------------------------ | --------------------------------------------------------------------------------------- |
| Variables and functions | -                                    | Declarations shared by the sections below, e.g. `int count = 0;` or a helper function.  |
| setup()                 | once at boot                         | Start values, e.g. `count = 0;`.                                                        |
| On message              | for every value arriving on the wire | The payload is the String `value` (`value.toInt()`, `value.toFloat()`, `value == "1"`). |
| loop()                  | repeatedly, between the other nodes  | Lets the node act by itself: time things with `millis()`, send a count.                 |

**Inputs are variables.** Every node shows a variable name at the start of the line under its label: a unique default such as `GPIO4` (a GPIO input on pin 4), `ADC34`, `SW1` or `INJ2`. Click it on the box, or edit **Variable name** in Properties, to rename it (letters, digits and `_`, starting with a letter; C++ words such as `int` or `millis` are refused). A default name follows the pin when you change it; a name you chose stays. In a C/C++ node, each node wired into it is a **typed** variable of that name holding its latest value, and `from` names the input that just sent `value`. So one C/C++ node can combine several inputs:

```cpp
// On message, with Switch SW_A and Switch SW_B wired into this node
send(SW_A && SW_B ? 1 : 0);   // a two-input AND gate: SW_A and SW_B are bool
```

The type comes from the node the value comes from; **Output type** in that node's Properties changes it:

| Input node                                                               | Variable type                                                                   |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| Switch, Push button, GPIO input, GPIO input (change), Pulse, Pulse train | `bool` (`false` until it sends)                                                 |
| Analog sample                                                            | `int`                                                                           |
| Map range, Threshold                                                     | `double`                                                                        |
| Inject                                                                   | from its payload: `5` → `int`, `2.5` → `double`, `true` → `bool`, else `String` |
| Radio in, Web in, BLE in, Terminal, Template, C/C++                      | `String` (`""` until it sends)                                                  |
| Compare, Throttle, Link in, outputs                                      | the type of their input (`String` if their inputs differ)                       |

Text arrives as `String` rather than a character array: `TEXT == "on"` then compares the text (with a `char[]` it would compare addresses). Conversions use `asBool()`, `asInt()` and `asDouble()`, which you can call yourself too. The node's Properties (and the code editor) list its inputs with their types, e.g. `bool DOOR, int ADC34`. Inputs that only report changes (GPIO input (change), Switch) keep their start value until their first change, so the AND gate example remembers each button from its own messages using `from`.

**Input and output types.** Every node has an input variable (unless it only sends, like a Switch) and an output variable (unless it only receives), each with a type: `bool` (on / off, sent as `1` / `0`), `int`, `float` (a decimal number; `double` in C++) or `String`. The types are shown inside the node box under its variable name: `float → int` (input → output), or `out bool` / `in String` for nodes with only one side; a type you chose is bold blue. In Properties, **Input type** and **Output type** are **auto** at first: the node's own type, nothing converted, so flows behave as before. Choosing a type converts every value the node receives (Input type) or sends (Output type), on the board and in the PC simulator alike:

| To       | Rule                                                                                        |
| -------- | ------------------------------------------------------------------------------------------- |
| `bool`   | `1` when the value is a number other than 0 or the text `true` / `on` / `yes`, else `0`     |
| `int`    | the number with its decimals cut off (`12.75` → `12`); text that is not a number → `0`      |
| `float`  | the number with up to 6 decimal places (`12.400` → `12.4`); text that is not a number → `0` |
| `String` | the value unchanged                                                                         |

A wire where a chosen type changes the value shows the conversion on the wire (e.g. `float→int`); conversions that lose something (to `bool`, `float` → `int`, text → number) are drawn in amber and listed as warnings in the node's Properties and before upload. Example: a GPIO output always takes `bool` (its Input type), so `0.7` from a Map range switches it on.

**JSON payloads.** Payloads are text, so JSON passes through every node unchanged. In a C/C++ node, helper functions read it, with no library to install:

| Function                                | Gives                                                                                                                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jsonNumber(value, "sensor.temp")`      | The number (a quoted number works too); `0` if missing, or `jsonNumber(value, "x", -1)` for another fallback.                                                             |
| `jsonText(value, "name")`               | The text of a string (escapes decoded), or any other value as written, e.g. `[1,2]`; `""` if missing.                                                                     |
| `jsonBool(value, "on")`                 | `true` for `true`, a non-zero number, `"true"`, `"on"`, `"yes"`.                                                                                                          |
| `jsonHas(value, "list[2]")`             | Whether the field exists.                                                                                                                                                 |
| `Json().add("temp", t).add("ok", true)` | Builds `{"temp":21.5,"ok":true}`; `send()` it directly. `add(key, x, 1)` rounds to 1 decimal place, `add(key, Json()…)` nests, `addJson(key, "[1,2]")` inserts JSON text. |

Paths use dots and indexes: `"a"`, `"a.b"`, `"list[0]"` or `"list.0"`; `""` is the whole value. Malformed JSON simply counts as missing. Example **C/C++ JSON** (file `arduino-json`) turns `{"temp": 21.5, "room": "lab"}` into `{"room":"lab","celsius":21.5,"fahrenheit":70.7,"hot":false}`.

`send(x)` passes `x` to the connected nodes: text, a whole number, or a decimal (`send(t, 1)` for one decimal place). It can be called from any section, any number of times. **Nothing goes on unless you call `send`**, so `return;` simply ends the section.

**Scoping.** Every C/C++ node gets a C++ namespace of its own, so its variables and functions are private: two C/C++ nodes can both have a `count`. Values enter only as `value` and the input variables, and leave only through `send`.

**No hardware access.** Code that uses hardware is refused when you save or build, with the line and the node to use instead:

| In code                                                                                   | Use instead                                         |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `pinMode`, `digitalRead`, `digitalWrite`, interrupts, `pulseIn`, `tone`, `shiftOut`, …    | GPIO input, GPIO input (change), GPIO output, Pulse |
| `analogRead`, `analogWrite`, `ledc…`, `dacWrite`                                          | Analog sample, PWM out                              |
| `Serial`, `Serial1`, `Serial2`                                                            | `send(…)` to a Debug node                           |
| `WiFi`, `mqtt`, `Wire`, `SPI`, `ESP`, BLE, OTA                                            | Radio in/out (MQTT, ESP-NOW, I2C), BLE, Web nodes   |
| `EEPROM`, `Preferences`, `SPIFFS`, `LittleFS`, `SD`                                       | not yet: storage will come as special functions     |
| chip drivers (`gpio_…`, `esp_…`, `uart_…`, …), registers (`REG_WRITE`, `volatile`, `asm`) | the hardware nodes                                  |

Comments and text in quotes are not checked, and names that merely start alike (`adc_value`, `digitalWriter`) are fine. Nodes cannot take these names as variable names either. Flows saved with the former **Pins** box load as before, without it: code that used those pins is then refused, so wire GPIO nodes in its place.

**Checks.** Microflow also rejects unbalanced brackets, `#include` and `#line`, and warns about `delay()` (it stops WiFi, MQTT and every other node; use `millis()`) and endless loops. Compiler errors name the node and box, e.g. `AND gate: on message:4:1: error: 'sendd' was not declared`.

**Simulation.** C++ cannot run on the PC: in ▶ Simulate the node passes values through unchanged (if its code calls `send`) and the console says so once. Test the code on a board: a debug build shows what it sends in the console and on the flowchart.

Example **C/C++ AND gate** (file `arduino-and-gate`): two GPIO input (change) nodes read buttons on GPIO 4 and 5 and are wired into a C/C++ node, where they are `bool BTN_A` and `bool BTN_B`; it sends `1` while both are pressed, else `0`, to the LED, and a second C/C++ node counts how often that happened with its own `count`. Below, Switch A and Switch B (`SW_A`, `SW_B`) are wired into one C/C++ node that ANDs them.

### Advanced node settings

Some nodes have **Advanced settings** in Properties, folded away until you open them (they open by themselves when one is in use).

**Radio out (MQTT)**

| Setting            | Use                                                                                                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Broker             | A broker for this node only: `host`, `host:port` or `mqtt://host:port`. Blank = the flow's broker (Device panel). No TLS (`mqtts://`): the board connects in plain MQTT.                         |
| Client ID          | Its MQTT client ID; blank = `<Device ID>-<node id>`. Must differ from every other client on that broker.                                                                                         |
| Username, Password | The login for that broker. The password is hidden while typing and left out of **Export** (enter it again after importing); saved flows on this PC keep it, like the WiFi password.              |
| Payload            | What is published: the incoming value (default), **fixed text**, a **template** (`{"t":{{payload}}}`), or the **complete msg** (Node-RED language: the message with this node's Message fields). |

With a broker of its own, the board keeps a second MQTT connection for this node: it connects once WiFi is up and reconnects after 5, 10, 20, then every 30 s. Messages sent while it is not connected are dropped (QoS 0), as are messages from the PC simulation until it has connected. The flow's broker stays in use for everything else (debug, tests, other nodes).

**Threshold**

| Setting       | Use                                                                                                                                                                                                                                                                           |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Refresh every | `0` = off. Otherwise, so many ms after the last value arrived (at least 100), it checks that value again and, if it still passes, sends it again; then again every period until a new value arrives. Receivers that start late, or a display, keep getting the current value. |

### Settings ⚙: Node-RED or Arduino language

The gear at the bottom of the green bar opens **Settings**. Its first option is the **language** of the flow: how values travel between its nodes. The choice is saved with the flow, and new flows start with the language chosen last. Flows saved before this setting existed use Arduino.

|                 | Node-RED                                                                                                                                | Arduino                          |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| On a wire       | A JSON message, like Node-RED's `msg`: `{"payload":1,"topic":"SW1"}`                                                                    | A plain value: `1`, `21.5`, `on` |
| Nodes           | Work on `msg.payload` and pass the other fields on                                                                                      | Work on the value                |
| Message box     | Each node has one, prefilled (inputs: `{"topic":"<variable name>"}`, others `{}`); its fields are added to what the node sends          | -                                |
| C/C++ node code | C++: `value` = `msg.payload`, `msg` = the whole message, `send(x)` keeps the message's fields, `sendMsg(Json()…)` sends a whole message | C++: `value`, `send(x)`          |
| Debug           | **Output**: `msg.payload` or the complete message                                                                                       | The value                        |
| Firmware        | Slightly larger (message handling)                                                                                                      | Smallest                         |

The badge next to the flow name shows the language (click it to open Settings). Both languages run entirely on the board: code is C++ in both, since the chips cannot run JavaScript. The PC simulation builds the same messages as the firmware.

In Node-RED language, a node sends: the new payload, then the fields of its Message box, then the fields of the message it received. A Switch named `DOOR` sends `{"payload":1,"topic":"DOOR"}`; a Template with Message `{"room":"lab"}` after it sends `{"payload":"door 1","room":"lab","topic":"DOOR"}`. `payload` cannot be set in a Message box: the node sets it. Radio out, Web out, Display and GPIO nodes use `msg.payload`. Example **Node-RED messages** shows a reading travelling with its topic and room, and a C/C++ node combining `bool DOOR` with `String CHECK`.

### Radio in / Radio out: MQTT, ESP-NOW or I2C

**Radio in** and **Radio out** (formerly MQTT in/out; saved flows load unchanged with MQTT) choose their transport under **Protocol** in Properties. Only the fields for that protocol are shown.

| Protocol           | Needs                   | Radio out                                                                    | Radio in                                                             |
| ------------------ | ----------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **MQTT**           | WiFi + broker           | publishes to the topic                                                       | subscribes (`+`/`#`)                                                 |
| **ESP-NOW**        | ESP32 boards, no router | broadcasts topic + payload (≤ about 180 bytes) to every ESP32 on the channel | keeps messages whose topic matches                                   |
| **I2C controller** | any board, 3 wires      | writes the value to the peripheral address                                   | polls the address every _Poll every_ ms and passes on each new value |
| **I2C peripheral** | ESP32 board             | sets the reply returned to the controller's polls                            | receives what the controller writes                                  |

- **ESP-NOW channel:** boards that join WiFi use the router's channel; boards without WiFi (Release builds without remote update or MQTT) use the channel set in the box, so set it to your router's channel when both kinds talk. Messages are not encrypted.
- **I2C:** one role per board; all I2C boxes on a board share SDA/SCL (switching a box to I2C fills in the board's usual pins: ESP32 21/22, ESP32-S3/C3 8/9, ESP8266 4/5). Wire SDA, SCL and GND between boards with 4.7 kΩ pull-ups to 3.3 V, and keep wires under about 1 m. Messages are up to 120 bytes.
- **Simulator:** ESP-NOW loops back to the simulated board's own Radio in boxes; I2C is logged as board-only.

**ESP-NOW samples** (files in `examples/`, each with tests):

| Sample                       | Board          | Shows                                                                          |
| ---------------------------- | -------------- | ------------------------------------------------------------------------------ |
| ESP-NOW loopback (one board) | any ESP32      | Radio out → Radio in on one chip (flow and topics; not the radio path)         |
| Lesson 10 · ESP-NOW link     | 2 × ESP32      | a switch on one board lights the LED on the other, no router                   |
| ESP-NOW sensor (sender)      | any ESP32      | knob in % broadcast as `sensor/<device>/level`                                 |
| ESP-NOW display (receiver)   | TTGO T-Display | levels from all senders on the screen; alarm above 80 % sent back over ESP-NOW |
| ESP-NOW ↔ MQTT gateway       | ESP32 on WiFi  | ESP-NOW levels published to the broker; MQTT commands broadcast over ESP-NOW   |

Saved flows from before Radio in/out are updated once when the app starts: boxes still named "MQTT in"/"MQTT out" become "Radio in"/"Radio out" with protocol MQTT; custom names are kept.

**Local MQTT (this board is the broker).** Choose **Local MQTT** as the protocol and the board runs its own MQTT broker on your network (ESP32 boards; the `sMQTTBroker` library is installed on the first compile). Its Radio out boxes publish there, and its Radio in boxes receive what other boards, PCs (e.g. MQTT Explorer, Node-RED) and this board's own Radio out publish, with `+` and `#` wildcards. Clients connect to `mqtt://<board IP>:<port>` (1883 by default; the address is printed on USB serial once WiFi is up), with the optional username and password set in the boxes. All Local MQTT boxes on a board share one port and login. No outside broker is needed for this, so a release build with only Local MQTT runs without one; give the board a fixed IP in your router so clients always find it. QoS 0; retained messages are kept in RAM until the board restarts.

### Lessons

Ten **Lesson** flows (files `examples/learn-*.json`) teach the boxes step by step; for one node at a time, use **❓ Help example** in Node properties. Each runs in **▶ Simulate** (no board needed), explains what to try in its description, and comes with MQTT tests that check it works:

| Lesson                  | Teaches                                                                    |
| ----------------------- | -------------------------------------------------------------------------- |
| 1 · Hello, flow         | Inject (manual and repeating), Debug, how a payload travels                |
| 2 · Switch and LED      | Switch, Push button, GPIO output, Oscilloscope                             |
| 3 · Blink               | Pulse train: blinking without `delay()`, a fixed number of flashes         |
| 4 · Decisions           | Threshold and Compare stop or pass messages; Template, Radio in/out (MQTT) |
| 5 · Map range           | Analog sample, scaling 0–4095 to 0–100 %, clamping                         |
| 6 · Throttle            | Limiting a noisy signal to one message per second                          |
| 7 · PWM and Pulse       | LED brightness (duty 0–255) and a self-ending one-shot pulse               |
| 8 · MQTT remote control | Switching an LED with `on`/`off` messages and reporting its state          |
| 9 · Tabs and links      | Splitting a flow over tabs with Link out / Link in                         |
| 10 · ESP-NOW link       | Radio in/out with protocol ESP-NOW: two ESP32 boards talk without a router |

The **Template messages** example shows Template turning raw values into JSON and readable text.

### Bluetooth link (ESP32)

**BLE out** and **BLE in** connect boards that are close together (Bluetooth LE, roughly 10–30 m indoors) without WiFi or a broker. Boards that use the same **link name** hear each other. There is no pairing and there are no roles: any number of boards can share a link, and one flow can use several links. A board does not receive its own messages.

- Connectionless: each value is broadcast as a non-connectable advertisement for 250 ms (company ID `0xFFFF`, a 3-byte id derived from the link name, and a sequence number so receivers deliver it once). It suits a few values per second, such as buttons, readings or commands, but not streaming. Delivery is not acknowledged.
- Values are text up to 20 bytes; longer values are cut.
- ESP32, ESP32-C3 and ESP32-S3 only (ESP8266 has no Bluetooth). When WiFi is also on, the receiver scans half of the time so WiFi keeps its share of the radio.
- Flows with BLE nodes are built with the **Minimal SPIFFS** partition scheme (1.9 MB app, OTA kept), because Bluetooth and WiFi together do not fit the default 1.25 MB. After adding BLE nodes, upload over USB the first time. Remote updates work after that.

The **Bluetooth link (two boards)** example sends the BOOT button (GPIO 0) and drives the LED (GPIO 2). Upload the same flow to two ESP32 boards, and pressing BOOT on one lights the LED on the other.

### Built-in display (LILYGO TTGO T-Display)

Choose **ESP32 · LILYGO TTGO T-Display (1.14″ LCD)**. The ST7789V screen (240 × 135, landscape) is wired as MOSI 19, SCLK 18, CS 5, DC 16, RST 23 and backlight 4 (per LILYGO's wiki), so those pins are reserved; flows that use them are refused. The two buttons are GPIO 0 (also BOOT) and GPIO 35 (input-only).

The **Display** node (OUTPUT) writes its label plus the payload on a row of the screen: rows 0–6, small/medium/large text, seven colours, and optional text shown at boot. The payload passes through, so it can also go to MQTT. Debug builds add the terminal command `lcd <row> <text>` / `lcd clear`. The PC simulator draws a virtual LCD next to the virtual pins.

Firmware uses the Adafruit ST7789 and GFX libraries ("Adafruit ST7735 and ST7789 Library"), installed on the first build. The **TTGO T-Display demo** example shows a title, both buttons, an analog input and MQTT text, with two tests.

### Built-in OLED (Heltec WiFi Kit 32, Lolin32 OLED)

Boards with a 0.96″ SSD1306 OLED (128 × 64) take Display nodes too: **ESP32 · Heltec WiFi Kit 32 V2** (OLED on I2C SDA 4, SCL 15, reset 16, screen power Vext on GPIO 21; LED 25, PRG button 0), **ESP32-S3 · Heltec WiFi Kit 32 V3** (SDA 17, SCL 18, reset 21, Vext 36; LED 35, PRG button 0) and **ESP32 · Wemos Lolin32 OLED** (SDA 5, SCL 4). The screen's pins are not offered for other nodes; other I2C parts can share its bus. The OLED shows the same rows 0–6 in small white text (21 characters a row); the size and colour of a Display node are ignored there. The Adafruit SSD1306 and GFX libraries are installed on the first build. If the OLED does not answer at start-up the flow runs without it.

### Board checks

Choose the board in the Device panel: NodeMCU, Wemos D1 mini, ESP-01 (1 MB), ESP32 Dev Module (30-pin or 38-pin DevKitC), LILYGO TTGO T-Display, Heltec WiFi Kit 32 V2 or V3 and Wemos Lolin32 OLED (built-in 0.96″ OLED), AI-Thinker ESP32-CAM, ESP32-C3 SuperMini (16 pins, USB-C is the chip's own USB), ESP32-C3 Mini dev board (ESP32-C3-MINI-1, 2 × 15 pins, dual Type-C: the socket beside the USB-serial chip (CH343P or CH340K) is UART0, which the serial monitor uses; the other is the chip's own USB, whose GPIO 18/19 are also on the header), ESP32-C6 SuperMini (20 pins; its USB-C is the chip's own USB, so uploads and the serial monitor use it with any baud rate), ESP32-S3 or Freenove ESP32-S3 WROOM CAM (camera, octal PSRAM), Waveshare ESP32-P4-WIFI6, the Realtek RTL8720DN BW16 module, or a Raspberry Pi Pico, Pico W, Pico 2 or Pico 2 W (see below). Click or right-click the board card under Board for a drawing of the board with every pin labelled, the pins the flow uses highlighted, and what each USB socket is for. The panel checks pins live:

**Waveshare ESP32-P4-WIFI6** (ESP32-P4 + ESP32-C6): the P4 runs the flow (32 MB flash, 32 MB PSRAM); its WiFi 6 and Bluetooth 5 come from the ESP32-C6 next to it (ESP-Hosted over SDIO, as Arduino-ESP32 expects: GPIO 14–19 and 54, not on the header). Needs the ESP32 core 3.3 or newer with the P4 (board "ESP32P4 Dev Module"; Microflow sets chip v3.x, PSRAM, 32 MB flash and a partition with two 4.5 MB app slots, so **remote update works**). USB-C is a CH343 USB-serial port (upload, serial monitor). Header pins: the 27 GPIOs on the two 20-pin rows; analog inputs 20–23 and 49–52; I2C on SDA 7 / SCL 8 (shared with the onboard ES8311 audio codec). Everything works except ESP-NOW (the radio is on the C6) and the DS18B20 (its OneWire library does not build for the P4; use a DHT or an analog sensor). The C6 runs Espressif's ESP-Hosted firmware: if WiFi does not start (an SDIO or version error on USB serial), update the C6 firmware to the version your ESP32 core expects. Compile-tested with arduino-esp32 3.3.11; check the chip revision printed at boot is v3.x (older engineering samples need ChipVariant "Before v3.00").

**Realtek RTL8720DN · BW16 module** (Ai-Thinker BW16-Kit): a non-Espressif board with dual-band WiFi (2.4 and 5 GHz). Choose **BW16 module (Type-C)** for the USB-C kit (uploads start by themselves) or **BW16 module (Burn button)** for the micro-USB kit (hold **Burn**, press and release **RST**, release **Burn**, then upload; that kit's USB chip is wired to pins 4/5, so connect a USB-serial adapter to 0/1 as in Realtek's guide). The first compile installs Realtek's Arduino core (`realtek:AmebaD`, about 110 MB from GitHub, once). Pins are the numbers printed on the kit, 0–12 (3 = PA30): PWM on 3, 7, 8, 11, 12; one analog input, 6 (A2, read at 12 bits); I2C fixed on SDA 8 / SCL 7; 0/1 are the USB serial; 10, 11, 12 are the green, blue and red LED. What works: GPIO, PWM, analog, timers, logic, C/C++, Radio in/out over MQTT and I2C, PWA, Terminal, Debug, sensors (DS18B20, DHT, NTC, gyroscope), servo / stepper, I2C OLED and LCD, debug builds, PC input emulation and Node-RED language. Not on this board: Web in/out (no ESP web server), ESP-NOW and Local MQTT (ESP32 only), the BLE boxes (they use the ESP32 Bluetooth API), Voice command / Speak / Camera, and remote update (upload over USB). Set a **Device ID** for it: without one, its ID comes from the WiFi MAC address.

**Raspberry Pi Pico · Pico W (RP2040) · Pico 2 · Pico 2 W (RP2350)**: built with Earle Philhower's Arduino core (`rp2040:rp2040`; the first compile installs it if Arduino IDE has not, about 300 MB, once). Pins are the GP numbers printed on the board: GP0–GP22 and GP26–GP28, all with PWM and pull-ups; analog inputs GP26, GP27, GP28 (read at 12 bits); I2C on I2C0 pins (GP4 SDA / GP5 SCL by default; SDA GP0/4/8/12/16/20, SCL GP1/5/9/13/17/21). Serial is the chip's own USB, so the baud rate does not matter. The **W** boards have WiFi (2.4 GHz): Radio in/out over MQTT, Web in/out, PWA and telemetry work as on an ESP board; the Pico and Pico 2 without W run offline (GPIO, logic, sensors, I2C, Debug and the test terminal over USB). Upload over USB: on this PC the upload restarts the Pico into its USB drive and copies the firmware; from the browser (**Upload → USB on this computer**, also for guests) click **① Restart the Pico as a USB drive**, then **② Save the firmware onto the Pico drive** and choose the drive named RPI-RP2 (Pico) or RP2350 (Pico 2). A new Pico, or one that does not react: hold **BOOTSEL** while plugging in the USB cable. Not on these boards: ESP-NOW, Local MQTT, the BLE boxes, Voice command / Speak / Camera, and remote update. Without a Device ID, the board's ID comes from its flash chip's unique ID.

- **Errors** block firmware: flash pins (GPIO 6–11 on ESP8266/ESP32), pins the chip lacks, outputs on ESP32 input-only pins 34–39, and analog reads on pins without a usable ADC. ADC2 is excluded on ESP32 because it doesn't work while WiFi is on.
- **Warnings** flag boot strapping pins, pins shared with UART or USB, a pin used as both input and output, and nodes that can never run.

Pins are chip GPIO numbers, not NodeMCU D-labels.

**Pin guide:** selecting a node that uses a pin shows advice for the chosen board under Node properties. It says whether the pin can do what the node needs (input, output, PWM, analog), flags input-only pins, pins without an internal pull-up, display pins and boot pins, and lists suitable pins as buttons; click one to use it. The guide follows the same rules as the board check.

### Board web page, JSON API and Terminal

With **Web in** or **Web out** nodes, the board runs a web server on port 80. The full URL is shown on each node in the flowchart: the board's IP once it is known from chip status or telemetry, or `http://<board IP>` until then. In host simulation the URL points to this PC.

| Request            | Does                                                                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /`            | Page with the live values, an input box per Web in, and a terminal.                                                                                                |
| `GET /api`         | `{"<Web out name>": value, …}`, with `null` until a value is set.                                                                                                  |
| `GET /api/<name>`  | `{"<name>": value}` for one Web out.                                                                                                                               |
| `POST /api/<name>` | The body (any JSON: number, object, …) goes to the Web in nodes named `<name>`. The flow runs, then the reply is `GET /api`, so one request does input and output. |
| `POST /terminal`   | One terminal line, with a plain-text reply.                                                                                                                        |

- Web out values that already are JSON (numbers, `true`/`false`/`null`, objects, arrays, strings) pass unchanged. Other text becomes a JSON string.
- Give a Web in and a Web out the same name to make a read/write variable, for example `led`.
- CORS is open and there is no login. Anyone on the same network can read and post, so use it only on a network you trust.
- Web nodes need WiFi, so a release build with Web nodes still starts WiFi and the MQTT client.

**Terminal** nodes fire on `<command> <data>` typed in any terminal: USB serial, the test terminal (over USB or MQTT), or the board page. Debug builds route the line through the test terminal. Release builds read USB serial for Terminal nodes only. Built-in command words such as `gpio` or `send` cannot be used. In the simulator, use the test terminal, `POST /sim/terminal`, or the page at `/sim/`. The simulator also serves the API at `/sim/api`.

The **Web API + terminal** example switches the LED from `POST /api/led` (`1`/`0`) or by typing `led 1`. It also publishes a light reading, and echoes `say <text>` or a posted `/api/message` as JSON.

## Ask AI (Copilot or Gemini)

**Right-click** a node in the palette (left) for ready-made questions about it. (On the canvas, right-click opens copy and paste instead.) For example, right-clicking **Throttle** offers _"How do I use the throttle in Node-RED (the delay node in rate-limit mode)? Show a simple example flow."_ Clicking a question copies it; **Copy first + open Copilot/Gemini** also opens the AI. Most boxes work like Node-RED's, so its answers apply; hardware and Radio boxes add ESP32/Arduino questions.

The **Ask AI** tab (right-hand panel) suggests questions made from the selected node: what it does, what feeds it and where its value goes, its pin, its type conversions and any warning the checks give about it. Click one to put it in the box and copy it (edit it and copy again if you like); while the tab is open, selecting another node updates the suggestions. Or use the question box: type your own question and press **Copy question** (or **Ctrl+Enter**) to put it on the clipboard. With **Add context** ticked (the default), the copied text starts with one paragraph about your setup: Microflow, the board, the flow language and the selected node with its settings (never passwords, keys or WiFi details); the box and Recent questions keep just your question. The tab also lists recent questions and has **Open Copilot** / **Open Gemini** (which copy the question too). The AI opens in its own window docked at the right edge of the screen, because these sites cannot be shown inside another page; paste the question with Ctrl+V. **Shift + right-click** (and right-click in text fields) keeps the browser's own menu. Do not paste passwords or WiFi keys into an AI.

## Test over MQTT

Run an MQTT broker such as Mosquitto and enter its URL and optional credentials. Pick a runtime mode in the list at the bottom, then press the start button beside it, which follows the list: **Simulate on this PC** → **▶ Simulate**, **Real board (monitor)** → **▶ Start MQTT test**, **Real board + PC inputs (USB)** → **▶ Start Real Simulation**. Restart the runtime after editing the flow.

- **Simulate on this PC** (optional tool, for trying a flow before a board is available) runs the flow on the host against the real broker. Nodes execute depth-first, in the same order as on the device, using the same topics. Hardware is simulated: the **Virtual pins** strip shows output pins and lets you toggle digital inputs or set analog values. While simulating, **GPIO input** and **GPIO input (change)** boxes also get **PUSH** (held = pressed) and **SWITCH** (click to flip): pressed drives the pin to its active level, LOW with the internal pull-up (a button to GND) and HIGH with a floating input. So with a pull-up a pressed button reads `0`; a Toggle or Pulse after it reacts to 0→1, i.e. on release. Blank Device ID simulates as `sim`.
- **Real board (monitor)** doesn't execute the flow. It listens to the board's status, telemetry, debug and flow topics. ▶ on a manual inject node publishes to the board's inject topic, so you trigger the real chip.

### Broker loopback test

**⇄ Test broker (loopback)**, under the Broker URL, checks the broker on its own, with no board. The PC connects with the configured URL and credentials, then subscribes to a private random topic (`microflow/_loopback/<random>`). It sends 5 QoS 0 messages and 1 QoS 1 message to itself, timing each round trip and the broker's acknowledgement (PUBACK).

Run it first when MQTT tests fail. If it fails, the problem is the broker URL, credentials, permissions or network; if it passes, look at the board. It doesn't prove the _board_ can reach the broker; **Verify board** checks that.

### Public test broker

**Use public test broker** (next to MQTT CONNECTION) fills in `mqtt://test.mosquitto.org:1883` for the PC and `test.mosquitto.org` for the board. Re-upload so the board uses it. Anyone can read a public broker, so:

- **Unique topics:** put `{{device}}` in Radio in/out topics, e.g. `microflow/{{device}}/led`. The firmware replaces it with the board's Device ID, the simulator with `sim`, and tests with the target device, so topics never collide with other users.
- **Only your board:** in **Real board (monitor)** mode the runtime listens to that one board's topics, so other people's boards don't appear under Devices.
- **No secrets:** never send passwords or private data through it.

### MQTT broker board (ESP32 / ESP32-S3)

**⇄** in the left bar programs an ESP32, ESP32-S3 or ESP32-C3 as your own MQTT broker on the LAN, replacing the public broker. Choose the board and its USB port, optionally a fixed IP (recommended, or reserve the address in the router) and a client username/password, then **Build and upload broker**. The app installs the `sMQTTBroker` library if needed, uploads, and checks the board over USB. It then shows `mqtt://<ip>:1883` (also `microflow-broker.local`) and **Use this broker for this editor and new uploads**, which sets the Broker URL, Firmware broker host/port and credentials. Upload your flows again so the boards use it, and keep the broker board powered.

**Heartbeat:** the broker reports itself like a Microflow board (retained `microflow/<id>/status` online, telemetry every heartbeat interval, default 30 s, and ping → pong), so it appears under Devices. Clients that miss their MQTT keep-alive are dropped after 1.5 × their interval; since the library has no Last Will, the broker publishes a dropped Microflow board's retained `offline` itself.

**TTGO T-Display:** the screen shows the broker's URL (`mqtt://<ip>:<port>`, plus `mqtt://microflow-broker.local:<port>`), login, clients, messages, WiFi signal and uptime at reset, when WiFi connects or drops, and when either button (GPIO 0 or 35) is pressed, then turns the backlight off after the screen on time (default 60 s, 0 = always on).

**Boards with a built-in OLED** (Heltec WiFi Kit 32 V2 / V3, Lolin32 OLED) show the same on it, in short rows (`<ip>:<port>`, `microflow-broker.local`, clients, messages, signal, uptime); the PRG / BOOT button wakes it.

**Other boards: an I2C OLED, if one is connected.** With **Show the broker on an I2C OLED if one is connected** ticked (the default), the broker looks at start-up for a 128 × 64 SSD1306 OLED at I2C address 0x3C or 0x3D on the board's usual I2C pins (shown in the form, e.g. SDA 21 / SCL 22 on an ESP32, 8 / 9 on an ESP32-C3) and, if one answers, shows its status there; the BOOT button wakes it. Without an OLED the broker runs as before. SH1106 OLEDs (often 1.3″) are not supported.

Limits: MQTT 3.1.1, QoS 0, plain TCP (no TLS), retained messages only until the broker restarts, and a handful of clients (an ESP32 handles roughly 5–10 connections well). Exposing it to the internet through router port forwarding works, but traffic and passwords then cross the internet unencrypted; prefer a VPN to your home network for remote access.

### Test cases

**Tests** (after saving the flow) stores repeatable test cases with the flow in SQLite. A test is a list of steps:

- **Publish** a payload to a topic.
- **Expect** a message on a topic (wildcards allowed) that matches _equals_, _contains_, _regex_, _≥ number_, _≤ number_ or _any_, within a timeout.
- **Expect none** asserts that a topic stays quiet for a duration.
- **Wait**.

`{{device}}` in topics and payloads is replaced with the target Device ID. The same suite therefore runs against the simulator (`sim`) or any board: set the Device ID, or press **Use** in **Devices**. New tests are pre-filled from the flow's MQTT inputs, outputs and debug nodes.

Expectations only count messages that arrive after the latest publish, and retained messages are ignored. Failures report what was actually seen. The latest 20 results per test are kept; the badge shows the last outcome.

Host tests support `mqtt://`, `mqtts://`, `ws://` and `wss://`.

## Device telemetry

Generated firmware uses the topic prefix `microflow/<Device ID>`. A blank Device ID becomes `microflow-<chip id>`.

- `…/status` is `online`, retained, with a last-will `offline`.
- `…/telemetry` carries uptime, free heap, RSSI, IP, build ID, board and flow name. It's sent every 30 s if telemetry is on.
- `…/debug/<node id>` receives debug output.
- `…/inject/<node id>` triggers manual inject nodes.

**Devices** lists every board heard while the runtime runs (either mode), with its status and last telemetry. It also shows which saved upload its build ID belongs to, so stale firmware is easy to spot. Turn telemetry off to save airtime; status and injects still work.

## Upload to a microcontroller

### Board check before a USB upload

Before compiling, a USB upload (and the MQTT broker board's upload) checks the target. First, the serial port must be connected: if it is not, the upload stops and lists the ports it found. Second, the chip on that port must be the one the chosen board is built for (ESP8266, ESP32, ESP32-S3, -C3, -C6 or -P4). It reads the chip with esptool, which comes with the ESP32 core; this resets the board once. A different chip stops the upload with buttons to switch to a board for that chip, so nothing is compiled or flashed for the wrong board. When the chip does not answer (some boards need BOOT held), the upload goes ahead with a warning. Realtek BW16 and Raspberry Pi Pico boards get the port check only (a Pico in BOOTSEL mode has no port: the upload then copies onto its USB drive).

### Serial monitor

Use the port refresh button to choose a USB serial adapter; detection doesn't require Arduino CLI.

- **Local serial** connects through the JavaScript server.
- **Web Serial** uses the browser's own port chooser. It needs Chrome or Edge in a secure context (HTTPS or localhost), and its selection doesn't fill the upload port field.

Choose 115200 baud for generated firmware. Monitor connections are released before upload. Other programs, such as Arduino IDE's monitor, must also release the port.

### Chip status over the serial terminal

When a serial connection is open, through **Local serial** or **Web Serial**, the **Chip status** card asks the firmware `mf?` every 2 s. It shows the board ID, build (and whether it matches your last upload), WiFi state with IP and signal, MQTT state, free heap and uptime. Status replies are kept out of the console; everything else the board prints still appears there.

The card explains problems in plain words: wrong WiFi password, broker unreachable, bad MQTT credentials, no reply (busy, crashed or not Microflow firmware), or unreadable data. Unreadable data usually means a crash loop: the boot ROM prints at 74880 baud. **⟲ Reset board** pulses the reset line (RTS) with GPIO0 released, like pressing RST, over either transport. Untick **Auto** to stop polling. The card needs 115200 baud and firmware uploaded by this version of Microflow.

Web Serial needs Chrome or Edge, and `http://127.0.0.1` or HTTPS. The browser's port picker chooses the board, so the server never opens the port.

### Compile and flash

Install [Arduino CLI](https://docs.arduino.cc/arduino-cli/getting-started/) and put it on PATH, or set `ARDUINO_CLI` to its path. Arduino IDE 2 bundles one at `C:\Program Files\Arduino IDE\resources\app\lib\backend\resources\arduino-cli.exe`. Install the cores and the MQTT library:

```powershell
arduino-cli config init
arduino-cli config add board_manager.additional_urls https://arduino.esp8266.com/stable/package_esp8266com_index.json
arduino-cli config add board_manager.additional_urls https://espressif.github.io/arduino-esp32/package_esp32_index.json
arduino-cli core update-index
arduino-cli core install esp8266:esp8266
arduino-cli core install esp32:esp32
arduino-cli lib install PubSubClient
```

Enter WiFi credentials, the firmware broker's LAN hostname or IP and port, and the USB serial port. The WiFi SSID and password are saved automatically in the local SQLite database (`settings` table, plain text) and refilled next time, in any browser; **Forget WiFi** deletes them. Other non-secret fields are remembered per browser. Then use one of:

- **Preview firmware** shows the generated `.ino`, its build ID and the board warnings.
- **✓ Compile** builds without a board and reports flash and RAM usage. The bar turns amber at 75 % and red at 90 %, which matters on the ESP-01.
- **Upload to board** compiles, then flashes.

**Speech (ESP32-S3):** **Voice command** (INPUT) recognises spoken commands offline with a PDM microphone on two pins, **CLK** and **DATA** (e.g. SPM1423 / MP34DT01; XIAO ESP32S3 Sense: CLK 42, DATA 41), using Espressif's ESP-SR in the ESP32 Arduino core (3.x). Each line of **Commands** is one command, and | separates phrases that mean the same (`lights on | turn on the light`); English words only. It sends the command (its first phrase) or its number; **Listening** waits for the wake word "Hi ESP" or listens always. It needs an ESP32-S3 with 16 MB flash and PSRAM (e.g. N16R8): the build uses the "ESP SR 16M" partition scheme, which uploads the speech models too. One Voice command box per chip. **Speak** (OUTPUT, ESP32 boards) says the text it receives (English, SAM synthesizer; ESP8266Audio + ESP8266SAM libraries, installed on the first build) through an I2S amplifier such as MAX98357A (**BCLK**, **LRC**, **DIN** pins); `{{payload}}` in its text is the value received, and Voice command stops listening while it talks. In **▶ Simulate**, a Voice command box has a text field and 🎤 (the browser's speech recognition), matched against its commands, and Speak talks through the PC's speakers. New boxes get pins that suit the board.

**PWA (phone keyboard):** the **PWA** node (INPUT) links a phone page that looks like a keyboard to the board over MQTT, with JSON both ways: the phone sends `{"key":"7"}` on `microflow/<device>/pwa/<node id>/in`, and the node sends on the key (`7`, `Enter`, …) or the whole JSON; what reaches the node's input is shown on the phone (retained on `…/out`): `{"text":"Door open","image":"alert"}` or plain text. Keys: **Keyboard** (digits, letters, Space, Enter, Back), **Keypad** (0–9, * #, arrows, OK) or **Custom** (rows of labels as JSON); no toggles, only keys. **Images** (JSON, name → URL or data URI) are static pictures the page carries, chosen by the board with `{"image":"name"}`; a small picture can also come over MQTT as a data URI (the MQTT buffer is 8 KB on ESP32 boards, 2 KB on ESP8266). A wire back into the PWA node (keys → logic → phone) is allowed: its input only shows on the phone. **📱 Publish test page** (Properties) writes the page (`index.html`, `pwa.json`, manifest, service worker, icon) to the project's `pwa/<name>/` folder (`<name>` = the node's variable name in lower case, e.g. PHONE → `pwa/phone/`) and opens it at `/pwa/<name>/`; `http://localhost:3000/pwa/` lists every published page: served by Microflow it talks through ▶ Simulate (or the board being monitored), no broker needed. That folder is also the installable PWA: copy it to any HTTPS static host (GitHub Pages, Netlify…) and set **Broker WebSocket URL** (`wss://…`) in the node, or on the phone with ⚙ (broker, Device ID, login); the page then uses MQTT over WebSocket (mqtt.js) and the board plain MQTT on the same broker. **⬇ pwa.json** downloads the page's settings. **Phone setup (QR code):** once the folder is on a static host, enter its address in **Published page address**; Properties then show a QR code (and Copy link) that opens the page on the phone already set up with the broker WebSocket URL and the board's Device ID (no passwords in it; a login is entered on the phone with ⚙). Then Add to Home screen installs it. (QR code generator: Kazuhiko Arase, MIT licence, `public/vendor/qrcode.js`.)

**Search the node library:** the box above the node library (left) shows only the nodes that match what you type: their name, group, help text or Node-RED name ("timer", "radio", "gpio out", "mqtt"); every word must match, and groups without a match hide. Enter adds the outlined match (a name match comes first), Esc clears, and **/** anywhere outside a text field jumps to the box.

**Custom nodes:** select two or more nodes (Ctrl+click, or drag a box around them), then **◈ Save as custom node** in Properties: give it a name and a description, and (by default) the selected nodes are replaced by one box. Wires that came into the group go to its **input** nodes, wires that left it come from its **output** nodes. The library is the **CUSTOM** group at the end of the node library (left): click an entry to add a box, × removes it from the library. It is stored with the app's settings, so every flow can use it; each box carries a copy of its nodes, so a flow with boxes also works on another PC. A box's Properties list what is inside, let you set the **pins** of its hardware nodes for that box (two boxes, two sets of pins), **Unpack** it back into its nodes (to see or edit them; Ctrl+Z undoes) and **Update library copy**. Before analysis, firmware and simulation the server expands each box into its nodes (variable names get _1, _2 … per box; boxes may contain boxes, up to 4 levels); messages name them as "Box · Node", and in the simulator the box flashes and shows the last value.

**Link table:** **⇄ Link** (top bar) opens a table of every Radio in of the project on the left (inputs) and every Radio out on the right (outputs), with chip, protocol, topic and what each one is linked to now (✗ when nothing). Pick one input and one output: the table proposes how to link them: the protocol (an input on another chip than a Local MQTT output becomes MQTT, i.e. it connects to that chip's broker) and a topic, keeping links the boxes already have where it can (the output's topic when other inputs hear it). Links the change would break are listed as conflicts; edit the topic to settle them, or apply anyway. **Apply link** writes the protocol and topic into both boxes (an input with a + or # filter that already covers the topic keeps it); Ctrl+Z undoes it. I2C boxes are linked by address.

**Checks before running:** **▶ Simulate** runs the flow as it is on screen (no saving or compiling needed); with unsaved changes it asks first: **Save & simulate**, **Simulate without saving** or **Cancel**. Runs on a real board (▶ Start MQTT test in a Real board mode, ▶ Start Real Simulation) need the board to run this flow: when the chip's flow (nodes, settings, wires, board) changed since its last upload from this app, or was never uploaded from it, they offer **Upload first**, **Continue anyway** or **Cancel**. An edit while a simulation runs shows **Edited since ▶ Simulate** with **↻ Restart**, since the simulation keeps the flow it started with.

**Split screen:** **⬒ Split** in the bottom bar divides the flow area into two identical screens, upper and lower, to work on two chips at once; **▭ Single** goes back to one. Each screen has its own chip bar, flow tabs, Undo / Clear and canvas, and both can be edited: the screen under the mouse is the editor: its flow tab shows a big green dot and **EDITING** (and a green edge on its left), the other screen a small hollow dot and **VIEW**. Add nodes from the palette, drag, connect, rename, select and delete, copy / paste and use Properties there; palette clicks and keyboard shortcuts go to the screen last under the mouse, and the Device panel follows its chip. The other screen keeps showing its chip and tab as they are, updated live while simulating. While simulating, each box shows the last value it handled under its name. Drag the bar between the screens to change their sizes (↑/↓ on the focused bar, Shift for bigger steps; double-click for half and half); the split and its size are remembered. With one chip, the second screen shows another flow tab of that chip. The top bars are compact to leave more room for the screens.

**Two monitors:** **⬒ 2 chips** in the Console header splits the debug monitor into an upper and a lower half, each showing one chip's messages (pick the chip in its header; they start as the two screens' chips, or the first two chips). The multi-chip simulator names the chip of every message; other messages (compile, upload, board checks, a single simulated chip) go to the chip being edited. Pause, Clear and Simulation / Upload / All act on both; drag the bar between them to resize (double-click: half and half). **▭ 1 monitor** goes back to one list.

**Console and right panel:** the debug console is the **Console** tab of the right panel (beside Device, Node and Ask AI). It shows one channel at a time: **Simulation** (simulator, MQTT tests, Real board monitoring and what the board prints), **Upload** (compile, upload and board checks) or **All**; errors and warnings join the channel last started. It switches by itself: ▶ Simulate, ▶ Start MQTT test and ▶ Start Real Simulation open it on Simulation, Compile and Upload on Upload. Drag the right panel's left edge to make it wider or narrower (240 px up to 60 % of the window; ←/→ on the focused edge, Shift for bigger steps); the width is remembered, and a double-click on the edge resets it.

**Progress bar:** compiling and uploading show a bar at the top of the screen with the step (detecting libraries, compiling the sketch, libraries and board core, linking, uploading), the percentage, the time so far and about how long is left. Compiling runs arduino-cli with `--verbose` to see its steps (the command lines are kept out of the console); how long each step took is remembered per board in `builds/<board>/timing.json`, so the estimate is close from the second build on. USB uploads follow esptool's percentages, remote updates their own.

Builds use a persistent per-board cache under `builds/<board>/`, so recompiles are incremental. Each board's sketch is overwritten, so old builds containing credentials don't pile up. Every compile and upload is logged with its build ID, sizes and errors under **Builds & uploads** (rail ⧗). `ARDUINO_CLI_TIMEOUT` (ms, default 300000) bounds a single CLI call.

A board on the network:

- **Must reach the broker.** `127.0.0.1` on a board means the board itself.
- **Uses plain MQTT** over WiFiClient to save resources.
- **Has your credentials in its firmware.** WiFi/MQTT credentials are embedded in the generated source and the `builds/` folder. Saved WiFi credentials are also in the SQLite database, so don't share `data/microflow.sqlite`. Flow exports never contain credentials.

### Test terminal

**Serial monitor:** on the Console tab's Simulation view, whenever the run mode is a real board (not *Simulate on this PC*), a strip at the top shows the board's serial output. Pick the **Baud** (default 115200, which the Microflow firmware uses), press **▶ Start** to open the serial port chosen in the Device panel (Local serial or Web Serial) and **■ Stop** to close it again (e.g. before an upload). The line box sends text to the board. The baud rate is shared with the Device panel; boards with built-in USB serial ignore it. While it is open the board's text appears there instead of in the console list.

**⌨ Terminal** (in the Console tab's bar) is a command line for testing the chip directly, without changing the flow. Commands go **via USB serial** (Local serial or Web Serial, once connected in the Device panel) or **via MQTT** (`microflow/<id>/cmd`, reply on `…/cmd/reply`; uses Device ID and Broker URL, so no cable is needed). ↑/↓ recalls earlier commands; the buttons send common ones.

| Command                                                                             | Does                                                                                     |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `help`, `status`                                                                    | List commands; build, ID, uptime, free heap, WiFi and MQTT state                         |
| `wifi`, `wifi scan`                                                                 | Current network; nearby networks with signal and channel                                 |
| `gpio read <pin>` · `gpio write <pin> <0\|1>` · `gpio mode <pin> <in\|pullup\|out>` | Test pins (only the board's usable GPIO; no output on input-only pins)                   |
| `adc [pin]` · `pwm <pin> <0-255>`                                                   | Read the ADC (default A0 / first ADC1 pin); drive PWM                                    |
| `nodes` · `send <node> <payload>`                                                   | List the flow's nodes; inject a payload into any node to test part of the flow           |
| `camera`                                                                            | Camera node: take a picture now, whatever its input is; replies with the picture address |
| `pub <topic> <payload>`                                                             | Publish from the board                                                                   |
| `echo <text>` · `reboot`                                                            | Connection check; restart the chip                                                       |

**Baud rate:** Microflow firmware always talks at **115200**. The Baud rate selector can be changed while connected. **Auto-detect baud** (under the selector, or in the terminal warning) tries common rates, asks `mf?`, and keeps the readable one; it takes about 6 s. If a USB command gets no readable reply, the terminal says so and offers **Use 115200**, **Auto-detect baud** and **Reset board**. Readable text only at **74880** is the ESP8266 boot ROM, not a baud setting: a short burst after a reset is normal, but repeating `Fatal exception` lines mean the chip is crash-looping. Auto-detect reports this and offers to reset the board and detect again.

The terminal is part of **Debug** builds only; Release builds leave it out. Over USB, replies start with "» ". The PC simulator answers the same commands with virtual pins.

### WiFi and MQTT are optional (single chip)

Untick **WiFi and MQTT (untick for a single chip)** in the Device panel and the chip never starts WiFi or MQTT, even in a Debug build: no telemetry, MQTT tests or remote update, and no network name, password or broker needed. Upload and the test terminal use USB. Boxes that need the network (Radio in/out over MQTT, Web, PWA, local broker radios) are refused with a message naming them. Leave it ticked (the default) for the IDE's debugging over MQTT.

### USB test build (WiFi off, status on serial)

For a bench test without the network, tick **USB test (WiFi off, status on serial)** in the Device panel and upload over USB. WiFi stays off (no MQTT, telemetry or remote update; boxes that need WiFi, such as Radio out over MQTT or Web, are refused). Open a serial monitor at 115200 baud: the board prints the pin modes at start (`GPIO 2: INPUT_PULLUP <- GPIO input (change) (IN2)`), every value each box handles (`[1234 ms] GPIO output (OUT6) -> 1`) and the flow's pin levels every 2 s (`[pins] GPIO 2=1 GPIO 6=1`). Untick it for normal builds.

### PC input emulation (hardware-in-the-loop)

Test the real board while the PC plays its inputs: the flow runs on the chip, outputs (GPIO, PWM, Pulse, Display) and communication (WiFi, MQTT, Bluetooth, web page) are real, but the input boxes read values set on the PC.

1. In the Device panel choose a **Debug** build, tick **PC input emulation (USB)** and upload.
2. Press **▶ Start Real Simulation**. It connects the serial port if needed (Web Serial asks for the port), then checks before starting:

   | Check                       | Fails when                                                                                              |
   | --------------------------- | ------------------------------------------------------------------------------------------------------- |
   | Serial port connected       | no port chosen, or the port cannot be opened                                                            |
   | Baud rate                   | not 115200 (the firmware's rate)                                                                        |
   | Device answers (handshake)  | no reply to `mf?` (wrong port, no Microflow Debug firmware) or unreadable data (wrong baud, crash loop) |
   | Firmware supports PC inputs | the firmware was built without PC input emulation                                                       |
   | Board runs this flow        | only a warning: the board has an older build of the flow                                                |
   | Commands reach the board    | the board does not answer the `emu` command                                                             |

   When every check passes, the run starts; otherwise the dialog says what to fix and offers **↻ Check again**. (Choosing the runtime mode **Real board + PC inputs (USB)** and pressing **▶ Start MQTT test** starts it without the checks.)

**The boxes are the controls.** While it runs, every box has a **yellow outline**, and nothing in the flow changes between emulation and the real circuit (the same nodes, the same firmware options):

- **GPIO input / GPIO input (change)**: **PUSH** (held = pressed), **SWITCH** (ON = pressed, OFF = released) and **REAL** (read the real pin again). With a pull-up, pressed reads LOW, like a button to GND.
- **Analog sample**: a slider sets the value the board reads (0–4095, or 0–1023 on ESP8266); **REAL** reads the pin again.
- **Input device** (temperature, voltage, oscilloscope probe, gyroscope…): type a value and press Enter (or **PC**): the board sends it at the node's interval instead of reading the sensor (`emu node <node id> <value>`), so no sensor needs to be wired. **REAL** reads the sensor again.
- **GPIO output / PWM out / Pulse** show **HIGH** / **LOW**, **PWM <duty>** or **PULSE** as the real board reports them; **Output device** boxes (servo, stepper, I2C display…) show the value they act on (angle, text…), and every box shows the last value it handled.
- **Inject ▶** (and Switch / Push button boxes of older flows) fire on the board over USB.

The **PC INPUTS** strip lists the flow's input pins (GPIO input, GPIO input (change), Analog sample). Each starts on its real pin; click a GPIO to drive it from the PC (a pull-up button goes LOW first, like pressing it), move an ADC slider, or click **real** to hand the pin back. Switch and Push button boxes fire on the board (`send <node> <payload>`). While it runs, the board reports every box's output, so the GPIO circles, Oscilloscopes and node flashes show what the real board does. **■ Stop** returns all inputs to the real pins.

In the terminal: `emu` lists emulated pins, `emu <pin> <0-4095>` sets one, `emu <pin> off` releases it, `emu off` releases all. Limits: USB serial adds a few milliseconds, so use it for buttons, switches and slow sensors rather than fast signals; reports are capped at about 200 per second; Release builds never contain emulation.

### Upload methods (USB or remote)

**Upload to board** asks how to deliver the firmware:

| Method        | Needs                   | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **USB cable** | Serial port             | Always works; required for the first install. If a USB upload fails, the upload window shows the error, a reminder that the port may be in use by another program (Serial Monitor, PuTTY, a Web Serial tab, another Microflow window), and a live check of the port: busy, free, missing, or open in Microflow's own monitor. The ESP8266 core's `upload.py` exits with success even when esptool fails, so Microflow checks its output. |
| **Over MQTT** | Board Device ID, broker | **No router ports**: the PC and the board only make outgoing connections to the broker, so it works across networks and through public brokers. The image is encrypted (ChaCha20) and signed (HMAC-SHA256 over a fresh board challenge). Others on the broker can't read it (it contains WiFi credentials), replay it, or push their own. The last chunk is committed only after the signature verifies. Lost packets are resent.        |
| **Over LAN**  | Board IP                | ArduinoOTA/espota with a per-project password. PC and board must share a network, and Windows Firewall must allow espota/python to accept the board's connection.                                                                                                                                                                                                                                                                        |

Remote methods need the board to already run firmware built with **Remote update** on. If a board does not answer an over-MQTT update, Microflow finds out why instead of guessing. It pings the board (newer firmware reports whether it supports remote update), reads the status the broker stored for it (offline, or never seen: wrong Device ID or broker), and, if its serial port is set and free, checks it over USB. The USB check catches a crash loop (and resets it), WiFi or MQTT problems, or a different board on the port. After a remote update the IDE pings the board until the new build answers.

The remote-update keys are created once per Microflow database (`data/microflow.sqlite`) and compiled into each firmware. They're never sent to the browser or shown in previews. **Back up the database**: if it's lost, boards can only be updated over USB again. Anyone with the database can update your boards.

### Verify the board

After a successful upload, Microflow checks the board automatically. You can also run **✓ Verify board** in the Device panel at any time, or **Ping** a board in **Devices**. The checklist stops at the first failure and explains it:

| Check                   | How                                                                                                                                                              | Typical failure hint                                                |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Board answers over USB  | Sends `mf?` on the serial port at 115200; the firmware replies with an `MF:{…}` status line. DTR/RTS are held low, so the chip is not reset into the bootloader. | Port missing, or not Microflow firmware                             |
| Runs the uploaded build | Compares the build ID in that reply with the build just uploaded                                                                                                 | Old firmware still running                                          |
| WiFi connected          | Polls the board's `WiFi.status()`                                                                                                                                | SSID not found, wrong password                                      |
| MQTT connected (board)  | Polls the board's `mqtt.state()`                                                                                                                                 | Broker host unreachable from the board, bad MQTT credentials        |
| Broker round-trip       | The PC publishes a nonce to `microflow/<id>/ping` and waits for `<nonce> <build>` on `…/pong`                                                                    | The PC and the board use different brokers, or the board is offline |

Verification takes the serial port, so it disconnects the serial monitor first. Without a serial port it only pings the board, using the Device ID. If the Device ID is blank, it is learnt over USB, and you can keep it for tests with one click. The PC simulator answers pings as `sim`. Each run is logged under **Builds & uploads**.

### Firmware notes

- If WiFi is not connected, the firmware starts a new connection attempt after 10, 20 and 40 s, then every 60 s, without blocking the flow. An ESP32 can otherwise stay idle after one failed first attempt, e.g. when a router briefly refuses a board that was just reset. The board check waits up to 45 s for WiFi.
- Give every board its own Device ID (or leave it blank for the automatic chip-based one). Two boards with one ID also share an MQTT client ID and keep disconnecting each other; the upload window warns when the ID was seen on another board type.

- The main loop never calls `delay()`. MQTT reconnects every 5 s; the first attempt happens as soon as WiFi is up.
- WiFi credentials aren't rewritten to flash on every boot (`WiFi.persistent(false)`).
- An empty MQTT username is sent as none rather than `""`.
- The PubSubClient buffer is 512 bytes.
- Incoming topics are copied before dispatch, so nodes can publish from inside the MQTT callback safely.
- PubSubClient connection attempts can block while a broker is unreachable.
- USB upload needs physical hardware and correct drivers, and some boards need the boot button held.

## Validation

```powershell
npm test
```

Tests cover:

- Node semantics (host and firmware parity), config normalisation and board pin rules.
- Firmware generation details: telemetry, inject topics and escaping.
- SQLite migrations from the legacy schema, revisions, test storage, cascade deletes and device tracking.
- Host simulation, virtual pins, device mode and the test runner, all end-to-end against an in-process MQTT broker.

To also compile generated firmware with the real ESP8266 and ESP32 toolchains:

```powershell
$env:ARDUINO_CLI = "C:\Program Files\Arduino IDE\resources\app\lib\backend\resources\arduino-cli.exe"
npm run test:compile
```

Flashing hardware is not exercised by automated tests.

## Layout

| Path                | Purpose                                                               |
| ------------------- | --------------------------------------------------------------------- |
| `lib/nodes.js`      | Node types: editor fields, validation, host behaviour, C++ generation |
| `lib/boards.js`     | Board registry, pin rules, compile-size parsing                       |
| `lib/flow.js`       | Graph validation, board analysis, firmware generator                  |
| `lib/devices.js`    | Input device (sensors) and Output device (motors) nodes               |
| `lib/statusfw.js`   | Status node: the status display, its lines and firmware               |
| `lib/runtime.js`    | Host simulator / device monitor                                       |
| `lib/testrunner.js` | MQTT test-case runner                                                 |
| `lib/store.js`      | SQLite schema migrations and queries                                  |
| `lib/serial.js`     | Local serial monitor                                                  |
| `public/`           | Editor (`app.js`), panels (`panels.js`), serial and API helpers; `statusview.js` draws the Status display |
