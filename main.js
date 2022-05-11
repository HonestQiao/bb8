(function () {

	'use strict';

	if (
		location.hostname.endsWith('.github.io') &&
		location.protocol != 'https:'
	) {
		location.protocol = 'https:';
	}

	const elConnect = document.querySelector('#connect');
	const elStop = document.querySelector('#stop');
	const elAim = document.querySelector('#aim');
	const elRed = document.querySelector('#red');
	const elBlue = document.querySelector('#blue');
	const elGreen = document.querySelector('#green');
	const elOff = document.querySelector('#off');
	const elJoypad = document.querySelector('#joypad');
	const elMessage = document.querySelector('#message');

	const config = {
		mqtt: {
			enable: 1,
			host: '192.168.1.15',
			port: '8083',
			username: 'admin',
			password: 'public',
			topic: 'device/BB-8/command'
		},
		websocket: {
			enable: 1,
			host: '192.168.1.15',
			port: '1234',
			reconnect: 1
		}
	}

	const state = {
		'aim': false,
		'busy': false,
		'sequence': 0,
	};

	let controlCharacteristic;
	let coreHeading;
	let gattServer;
	let robotService;
	let radioService;
	let isvibrate = false;
	let bluetoothDevice = null;

	let socket;
	let mqtt_client = null;
	if (!window.WebSocket) {
		window.WebSocket = window.MozWebSocket;
	}
	// setVibrate();

	const isMobile = function () {
		const nav = navigator.userAgent.toLowerCase();
		return (
			nav.match(/iphone/i) || nav.match(/ipod/i) || nav.match(/ipad/i) || nav.match(/android/i)
		);
	};

	const setVibrate = function () {
		if (!isvibrate && isMobile && navigator.vibrate) {
			isvibrate = true;
			[
				elConnect, elStop, elAim, elRed, elBlue,
				elGreen, elOff
			].forEach(function (element) {
				element.addEventListener('touchstart', function (event) {
					navigator.vibrate(15);
				});
			});
		}
	}

	function openWsServer() {
		if (!config.websocket.enable) {
			return;
		}
		var host_port = window.location.host;
		if (window.WebSocket) {
			if (socket && socket.readyState == WebSocket.OPEN) {
				console.warn("WS is already opened.");
				return;
			}
			let ws_host = "ws://" + config.websocket.host + ':' + config.websocket.port;
			socket = new WebSocket(ws_host, "BB-8");
			socket.onmessage = function (event) {
				console.log('WS receive: ' + event.data);
				try {
					var json = JSON.parse(event.data);
					// putMessage(JSON.stringify(json));
					if (bluetoothDevice && "action" in json && "x" in json && "y" in json) {
						let x = Math.max(Math.min(json.x, radius * 2), 0);
						let y = Math.max(Math.min(json.y, radius * 2), 0);

						if (json.action == 'move') {
							runCtrl(x, y);
						}

						if (json.action == 'stop') {
							stopRolling();
						}
					}
				}
				catch (e) {
					console.error("WS: JSON parse error.", e.toString());
				}
			};
			socket.onopen = function (event) {
				console.log("WS is opened.");
			};
			socket.onclose = function (event) {
				console.log("WS is closed.");
				if (config.websocket.reconnect) {
					setTimeout(function () {
						openWsServer();
					}, 2000);
				}
			};
		} else {
			console.error("WS: Your browser is not support WebSocket.");
		}
	}

	function closeWsServer() {
		if (!config.websocket.enable) {
			return;
		}
		if (socket && socket.readyState == WebSocket.OPEN) {
			socket.close();
			console.log("WS is closed.");
		} else {
			console.log("WS is already closed.");
		}
	}

	function openMqttServer() {
		if (!config.mqtt.enable) {
			return;
		}
		// 连接选项
		const options = {
			clean: true, // true: 清除会话, false: 保留会话
			connectTimeout: 4000, // 超时时间
			// 认证信息
			clientId: 'BB-8',
			username: config.mqtt.username,
			password: config.mqtt.password,
		};

		// 连接字符串, 通过协议指定使用的连接方式
		// ws 未加密 WebSocket 连接
		// wss 加密 WebSocket 连接
		const connectUrl = 'ws://' + config.mqtt.host + ':' + config.mqtt.port + '/mqtt';
		const client = mqtt.connect(connectUrl, options);
		mqtt_client = client;
		console.log('MQTT is opened.');

		client.on('reconnect', (error) => {
			console.warn('MQTT is reconnecting.', error);
		});

		client.on('error', (error) => {
			console.error('MQTT connect failed.', error);
		});

		client.subscribe(config.mqtt.topic);
		client.on('message', (topic, message) => {
			console.log('MQTT receive: ', topic, message.toString());
			try {
				var json = JSON.parse(message.toString());
				// putMessage(JSON.stringify(json));
				if (bluetoothDevice && "action" in json) {
					if (['move', 'stop'].includes(json.action) && "x" in json && "y" in json) {
						let x = Math.max(Math.min(json.x, radius * 2), 0);
						let y = Math.max(Math.min(json.y, radius * 2), 0);

						if (json.action == 'move') {
							runCtrl(x, y);
						}

						if (json.action == 'stop') {
							stopRolling();
						}
					}
					if (['color'].includes(json.action) && "c" in json) {
						setColor(json.c[0], json.c[1], json.c[2]);
					}
				}
			}
			catch (e) {
				console.error("MQTT: JSON parse error", e.toString());
			}
		});
	}

	const setHeading = function (heading) {
		if (state.busy) {
			// Return if another operation pending
			return Promise.resolve();
		}
		state.busy = true;
		const did = 0x02;
		const cid = 0x01;
		const data = new Uint16Array([heading]);

		sendCommand(did, cid, data).then(() => {
			state.busy = false;
		})
			.catch(exception => {
				console.log(exception);
			});
	};

	// Code based on https://github.com/WebBluetoothCG/demos/blob/gh-pages/bluetooth-toy-bb8/index.html
	const roll = function (heading, speed, rollState) {
		console.log('Roll heading=' + heading + ', speed=' + speed);
		if (state.busy) {
			// Return if another operation pending
			return Promise.resolve();
		}
		coreHeading = heading;
		state.busy = true;
		const did = 0x02; // Virtual device ID
		const cid = 0x30; // Roll command
		// Roll command data: speed, heading (MSB), heading (LSB), state
		const data = new Uint8Array([speed, heading >> 8, heading & 0xFF, rollState]);
		sendCommand(did, cid, data).then(() => {
			state.busy = false;
		})
			.catch(exception => {
				console.log(exception);
			});
	};

	const stopRolling = function () {
		if (state.busy) {
			setTimeout(stopRolling, 100);
			// Return if another operation pending
			return Promise.resolve();
		}
		state.busy = true;
		const did = 0x02; // Virtual device ID
		const cid = 0x30; // Roll command
		// Roll command data: speed, heading (MSB), heading (LSB), state
		const data = new Uint8Array([
			100, coreHeading >> 8, coreHeading & 0xFF, 0
		]);
		sendCommand(did, cid, data).then(() => {
			state.busy = false;
			// bluetoothDevice = null;
			// elMessage.innerHTML = "Stop ok.";
		})
			.catch(exception => {
				bluetoothDevice = null;
				// elMessage.innerHTML = "Stop fail.";
				console.log(exception);
			});
	};

	const setBackLed = function (brightness) {
		console.log('Set back led to ' + brightness);
		const did = 0x02; // Virtual device ID
		const cid = 0x21; // Set RGB LED Output command
		// Color command data: red, green, blue, flag
		const data = new Uint8Array([brightness]);
		return sendCommand(did, cid, data);
	};

	// Code based on https://github.com/WebBluetoothCG/demos/blob/gh-pages/bluetooth-toy-bb8/index.html
	const setColor = function (r, g, b) {
		console.log('Set color: r=' + r + ',g=' + g + ',b=' + b);
		if (state.busy) {
			// Return if another operation pending
			return Promise.resolve();
		}
		state.busy = true;
		const did = 0x02; // Virtual device ID
		const cid = 0x20; // Set RGB LED Output command
		// Color command data: red, green, blue, flag
		const data = new Uint8Array([r, g, b, 0]);
		sendCommand(did, cid, data).then(() => {
			state.busy = false;
		})
			.catch(exception => {
				console.log(exception);
			});
	};

	// Code based on https://github.com/WebBluetoothCG/demos/blob/gh-pages/bluetooth-toy-bb8/index.html
	const sendCommand = function (did, cid, data) {
		// Create client command packets
		// API docs: https://github.com/orbotix/DeveloperResources/blob/master/docs/Sphero_API_1.50.pdf
		// Next sequence number
		const seq = state.sequence & 0xFF;
		state.sequence += 1;
		// Start of packet #2
		let sop2 = 0xFC;
		sop2 |= 1; // Answer
		sop2 |= 2; // Reset timeout
		// Data length
		const dlen = data.byteLength + 1;
		const sum = data.reduce((a, b) => {
			return a + b;
		});
		// Checksum
		const chk = ((sum + did + cid + seq + dlen) & 0xFF) ^ 0xFF;
		const checksum = new Uint8Array([chk]);
		const packets = new Uint8Array([0xFF, sop2, did, cid, seq, dlen]);
		// Append arrays: packet + data + checksum
		const array = new Uint8Array(packets.byteLength + data.byteLength + checksum.byteLength);
		array.set(packets, 0);
		array.set(data, packets.byteLength);
		array.set(checksum, packets.byteLength + data.byteLength);
		console.log('Sending', array);
		return controlCharacteristic.writeValue(array).then(() => {
			console.log('Command write done.');
		});
	};

	// Code based on https://github.com/WebBluetoothCG/demos/blob/gh-pages/bluetooth-toy-bb8/index.html
	function connect() {
		if (!navigator.bluetooth) {
			console.log('Web Bluetooth API is not available.\n' +
				'Please make sure the Web Bluetooth flag is enabled.');
			return;
		}

		console.log('Requesting BB-8…');
		elMessage.innerHTML = "Connecting...";

		const serviceA = '22bb746f-2bb0-7554-2d6f-726568705327';
		const serviceB = '22bb746f-2ba0-7554-2d6f-726568705327';
		const controlCharacteristicId = '22bb746f-2ba1-7554-2d6f-726568705327';
		const antiDosCharacteristicId = '22bb746f-2bbd-7554-2d6f-726568705327';
		const txPowerCharacteristicId = '22bb746f-2bb2-7554-2d6f-726568705327';
		const wakeCpuCharacteristicId = '22bb746f-2bbf-7554-2d6f-726568705327';
		navigator.bluetooth.requestDevice({
			'filters': [{ 'namePrefix': ['BB'] }],
			'optionalServices': [
				serviceA,
				serviceB
			]
		})
			.then(device => {
				console.log('Got device: ' + device.name);
				bluetoothDevice = device;
				elMessage.innerHTML = 'Got device: ' + device.name;
				device.addEventListener('gattserverdisconnected', onDisconnected);
				return device.gatt.connect();
			})
			.then(server => {
				console.log('Got server');
				gattServer = server;
				elMessage.innerHTML = 'Got server';
				return gattServer.getPrimaryService(serviceA);
			})
			.then(service => {
				console.log('Got service');
				// Developer mode sequence is sent to the radio service
				radioService = service;
				// Get Anti DOS characteristic
				elMessage.innerHTML = 'Got service';
				return radioService.getCharacteristic(antiDosCharacteristicId);
			})
			.then(characteristic => {
				console.log('> Found Anti DOS characteristic');
				elMessage.innerHTML = 'Found Anti DOS characteristic';
				// Send special string
				let bytes = new Uint8Array('011i3'.split('').map(c => c.charCodeAt()));
				return characteristic.writeValue(bytes).then(() => {
					console.log('Anti DOS write done.');
					elMessage.innerHTML = 'Anti DOS write done.';
				})
			})
			.then(() => {
				// Get TX Power characteristic
				elMessage.innerHTML = 'Get TX Power characteristic';
				return radioService.getCharacteristic(txPowerCharacteristicId);
			})
			.then(characteristic => {
				console.log('> Found TX Power characteristic');
				elMessage.innerHTML = 'Found TX Power characteristic';
				const array = new Uint8Array([0x07]);
				return characteristic.writeValue(array).then(() => {
					console.log('TX Power write done.');
					elMessage.innerHTML = 'TX Power write done';
				})
			})
			.then(() => {
				// Get Wake CPU characteristic
				elMessage.innerHTML = 'Get Wake CPU characteristic';
				return radioService.getCharacteristic(wakeCpuCharacteristicId);
			})
			.then(characteristic => {
				console.log('> Found Wake CPU characteristic');
				elMessage.innerHTML = 'Found Wake CPU characteristic';
				const array = new Uint8Array([0x01]);
				return characteristic.writeValue(array).then(() => {
					console.log('Wake CPU write done.');
				})
			})
			.then(() => {
				// Get robot service
				elMessage.innerHTML = 'Get robot service';
				return gattServer.getPrimaryService(serviceB)
			})
			.then(service => {
				// Commands are sent to the robot service
				robotService = service;
				// Get Control characteristic
				elMessage.innerHTML = 'Get Control characteristic';
				return robotService.getCharacteristic(controlCharacteristicId);
			})
			.then(characteristic => {
				console.log('> Found Control characteristic');
				elMessage.innerHTML = 'Found Control characteristic';
				// Cache the characteristic
				controlCharacteristic = characteristic;
				// alert('connect ok');
				elMessage.innerHTML = "Connected to " + bluetoothDevice.name;
				elConnect.innerHTML = "Connected";
				return setColor(0, 250, 0);
			})
			.catch(exception => {
				bluetoothDevice = null;
				elMessage.innerHTML = "Connect fail";
				elConnect.innerHTML = "Connect";
				console.log(exception);
			});
	};

	elConnect.onclick = function () {
		if (bluetoothDevice && bluetoothDevice.gatt.connected) {
			elMessage.innerHTML = "Connect ok";
		} else {
			connect();
		}
		openWsServer();
	};

	elStop.onclick = function () {
		elMessage.innerHTML = "Stoping...";
		if (bluetoothDevice && bluetoothDevice.gatt.connected) {
			stopRolling();
			setTimeout(() => {
				bluetoothDevice.gatt.disconnect();
				elMessage.innerHTML = "Stop OK";
				elConnect.innerHTML = "Connect";
				closeWsServer();
			}, 500);
		} else {
			elMessage.innerHTML = "Stop OK";
			elConnect.innerHTML = "Connect";
			closeWsServer();
		}
	};

	elAim.onclick = function () {
		state.aim = !state.aim;
		if (state.aim) {
			setBackLed(0xff).then(() => setColor(0, 0, 0));
		} else {
			setBackLed(0).then(() => setHeading(0));
		}
		elAim.classList.toggle('active');
	};

	elRed.onclick = function () {
		setColor(255, 0, 0);
	};

	elGreen.onclick = function () {
		setColor(0, 255, 0);
	};

	elBlue.onclick = function () {
		setColor(0, 0, 255);
	};

	elOff.onclick = function () {
		setColor(0, 0, 0);
	};

	const radius = 150;

	const onDisconnected = function (event) {
		if (bluetoothDevice) {
			const device = event.target;
			console.log(`Device ${device.name} is disconnected.`);
			elMessage.innerHTML = `Device ${device.name} is disconnected.`;
			bluetoothDevice = null;
		}
	}

	const runCtrl = function (x, y) {
		// Notes: x and y are swapped here in order to get clockwise theta from Y-axis.
		const theta = Math.PI - Math.atan2(x - radius, y - radius);
		const degrees = theta * (180 / Math.PI);
		const tx = Math.abs(x - radius);
		const ty = Math.abs(y - radius);
		let speed = Math.sqrt(Math.pow(tx, 2) + Math.pow(ty, 2));
		speed = speed / 150.0 * 255.0;
		console.log('event: ' + x + ', ' + y + ', d: ' + degrees + ' speed: ' + speed);
		if (state.aim) {
			roll(Math.round(degrees), 0, 1);
		} else {
			roll(Math.round(degrees), Math.round(speed), 1);
		}
	}

	const handleTouchEvent = function (event) {
		event.preventDefault();
		if (event.targetTouches.length == 1) {
			const touch = event.targetTouches[0];
			const x = touch.clientX - elJoypad.offsetLeft;
			const y = touch.pageY - elJoypad.offsetTop;
			// Notes: x and y are swapped here in order to get clockwise theta from Y-axis.
			runCtrl(x, y);
		}
	};

	elJoypad.ontouchstart = function (event) {
		handleTouchEvent(event);
	};

	elJoypad.ontouchmove = function (event) {
		setVibrate();
		handleTouchEvent(event);
	}

	elJoypad.ontouchend = function (event) {
		event.preventDefault();
		stopRolling();
	};

	let keyName = "";
	let keystring = "";//记录按键的字符串
	let keyDirs = [];
	let keyX = radius;
	let keyY = radius;
	let prev_dir = '';

	// function keyboard(eve) {
	// 	let key = eve.key;
	// 	let keyCode = eve.keyCode || eve.which;
	// 	console.log(`key=${key} keyCode=${keyCode}`);
	// }

	const handleKeyEvent = function (dir) {
		if (dir != "") {
			switch (dir) {
				case '[Left]':
					keyX -= dir == prev_dir ? 2 : 1;
					break;
				case '[Right]':
					keyX += dir == prev_dir ? 2 : 1;
					break;
				case '[Up]':
					keyY -= dir == prev_dir ? 2 : 1;
					break;
				case '[Down]':
					keyY += dir == prev_dir ? 2 : 1;
					break;
				default:
					break;
			}
			prev_dir = dir;
			keyX = Math.max(Math.min(keyX, radius * 2), 0);
			keyY = Math.max(Math.min(keyY, radius * 2), 0);
			runCtrl(keyX, keyY);
		}
	};

	// function keypress(e) {
	// 	var currKey = 0, CapsLock = 0, e = e || event;
	// 	currKey = e.keyCode || e.which || e.charCode;
	// 	CapsLock = currKey >= 65 && currKey <= 90;
	// 	switch (currKey) {
	// 		//屏蔽了退格、制表、回车、空格、方向键、删除键
	// 		case 8:
	// 		case 9:
	// 		case 13:
	// 		case 32:
	// 		case 37:
	// 		case 38:
	// 		case 39:
	// 		case 40:
	// 		case 46:
	// 			keyName = `[${currKey}]`;
	// 			break;
	// 		default:
	// 			keyName = String.fromCharCode(currKey);
	// 			break;
	// 	}
	// 	// keystring += keyName;
	// 	console.log("keypress:"+keyName);
	// }

	function keydown(e) {
		var e = e || event;
		var currKey = e.keyCode || e.which || e.charCode;
		if ((currKey > 7 && currKey < 14) || (currKey > 31 && currKey < 47)) {
			switch (currKey) {
				case 8: keyName = "[Backspace]";
					break;
				case 9: keyName = "[Tab]";
					break;
				case 13: keyName = "[Return]";
					break;
				case 32: keyName = "[Space]";
					break;
				case 33: keyName = "[PageUp]";
					break;
				case 34: keyName = "[PageDown]";
					break;
				case 35: keyName = "[End]";
					break;
				case 36: keyName = "[Home]";
					break;
				case 37: keyName = "[Left]";
					keyDirs.push(keyName); handleKeyEvent(keyName);
					break;
				case 38: keyName = "[Up]";
					keyDirs.push(keyName); handleKeyEvent(keyName);
					break;
				case 39: keyName = "[Right]";
					keyDirs.push(keyName); handleKeyEvent(keyName);
					break;
				case 40: keyName = "[Down]";
					keyDirs.push(keyName); handleKeyEvent(keyName);
					break;
				case 46: keyName = "[Delete]";
					break;
				default: keyName = "";
					break;
			}
			keystring += keyName;
		}
		console.log("keydown:" + keyName);
	}
	function keyup(e) {
		console.log("keyup:" + keystring);
		stopRolling();
		keyX = radius;
		keyY = radius;
		prev_dir = '';
		keystring = "";
		keyDirs = [];
	}
	// document.addEventListener('keypress', keypress);
	document.addEventListener('keydown', keydown);
	document.addEventListener('keyup', keyup);
	// document.onkeypress = keypress;
	// document.onkeydown = keydown;
	// document.onkeyup = keyup;

	openWsServer();
	openMqttServer();
}());
