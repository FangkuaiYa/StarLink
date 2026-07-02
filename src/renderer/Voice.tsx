import React, { useContext, useEffect, useMemo, useRef, useState } from 'react';
import Avatar from './Avatar';
import { GameStateContext, HostSettingsContext, PlayerColorContext, SettingsContext } from './contexts';
import {
	AmongUsState,
	GameState,
	Player,
	SocketClientMap,
	AudioConnected,
	ClientBoolMap,
	numberStringMap,
	Client,
	VoiceState,
} from '../common/AmongUsState';
import { ipcRenderer } from 'electron';
import VAD from './vad';
import { ISettings, playerConfigMap, ILobbySettings } from '../common/ISettings';
import { IpcRendererMessages, IpcMessages, IpcOverlayMessages, IpcHandlerMessages } from '../common/ipc-messages';
import Typography from '@mui/material/Typography';
import Grid from '@mui/material/Grid';
import makeStyles from '@mui/styles/makeStyles';
import SupportLink from './SupportLink';
import Divider from '@mui/material/Divider';
// validateClientPeerConfig removed — not used with Interstellar protocol
// @ts-ignore
import reverbOgx from 'arraybuffer-loader!../../static/sounds/reverb.ogx'; // @ts-ignore
import radioOnSound from '../../static/sounds/radio_on.wav'; // @ts-ignore

import { CameraLocation, AmongUsMaps, MapType } from '../common/AmongusMap';
import { ObsVoiceState } from '../common/ObsOverlay';
import Footer from './Footer';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import VolumeOff from '@mui/icons-material/VolumeOff';
import VolumeUp from '@mui/icons-material/VolumeUp';
import Mic from '@mui/icons-material/Mic';
import MicOff from '@mui/icons-material/MicOff';
import adapter from 'webrtc-adapter';
import { VADOptions } from './vad';
import { pushToTalkOptions } from './settings/SettingsStore';
import { poseCollide } from '../common/ColliderMap';

console.log(adapter.browserDetails.browser);

export interface ExtendedAudioElement extends HTMLAudioElement {
	setSinkId: (sinkId: string) => Promise<void>;
}

// ── Interstellar Protocol Types ──────────────────────────────────────────────
// MessageTag enum (matches C# Interstellar.Messages.MessageTag)
const enum MsgTag {
	Join = 0,
	Profile = 1,
	SdpOffer = 2,
	SdpAnswer = 3,
	AddIceCand = 4,
	ShareId = 5,
	ShareProfile = 6,
	NoticeDisconnect = 7,
	Custom = 8,
	RequestReload = 9,
	UpdateMuteStatus = 10,
	ShareMuteStatus = 11,
	HostSettings = 12,
	ServerInfo = 13,
}

interface InterstellarPeerInfo {
	playerName: string;
	playerId: number; // byte
	clientId: number; // Among Us clientId
}

interface PeerConnections {
	[audioId: number]: RTCPeerConnection;
}

interface VadNode {
	connect: () => void;
	destroy: () => void;
	options: VADOptions;
	init: () => void;
}

interface AudioNodes {
	dummyAudioElement: HTMLAudioElement;
	audioElement: HTMLAudioElement;
	gain: GainNode;
	pan: PannerNode;
	reverb: ConvolverNode;
	muffle: BiquadFilterNode;
	destination: AudioNode;
	reverbConnected: boolean;
	muffleConnected: boolean;
}

interface AudioElements {
	[peer: string]: AudioNodes;
}

interface ConnectionStuff {
	ws?: WebSocket;
	stream?: MediaStream;
	instream?: MediaStream;

	microphoneGain?: GainNode;
	audioListener?: VadNode;
	pushToTalkMode: number;
	deafened: boolean;
	muted: boolean;
	impostorRadio: boolean | null;
	toggleMute: () => void;
	toggleDeafen: () => void;
}

interface SocketError {
	message?: string;
}

// (ClientPeerConfig removed - not used with Interstellar protocol)

const DEFAULT_ICE_CONFIG: RTCConfiguration = {
	iceTransportPolicy: 'all',
	iceServers: [
		{
			urls: 'stun:stun.l.google.com:19302',
		},
	],
};

// DEFAULT_ICE_CONFIG_TURN removed — BCL TURN server is not available for StarLink.
// Users needing relay can configure a TURN server in their Interstellar server settings.

export interface VoiceProps {
	t: (key: string) => string;
	error: string;
}

const useStyles = makeStyles((theme) => ({
	error: {
		position: 'absolute',
		top: '50%',
		transform: 'translateY(-50%)',
	},
	root: {
		paddingTop: theme.spacing(3),
	},
	top: {
		display: 'flex',
		justifyContent: 'center',
		alignItems: 'center',
	},
	right: {
		display: 'flex',
		flexDirection: 'column',
		alignItems: 'center',
		justifyContent: 'center',
	},
	username: {
		display: 'block',
		textAlign: 'center',
		fontSize: 20,
		whiteSpace: 'nowrap',
		maxWidth: '115px',
	},
	code: {
		fontFamily: "'Source Code Pro', monospace",
		display: 'block',
		width: 'fit-content',
		margin: '5px auto',
		padding: 5,
		borderRadius: 5,
		fontSize: 28,
	},
	otherplayers: {
		width: 225,
		height: 225,
		margin: '4px auto',
		'& .MuiGrid-grid-xs-1': {
			maxHeight: '8.3333333%',
		},
		'& .MuiGrid-grid-xs-2': {
			maxHeight: '16.666667%',
		},
		'& .MuiGrid-grid-xs-3': {
			maxHeight: '25%',
		},
		'& .MuiGrid-grid-xs-4': {
			maxHeight: '33.333333%',
		},
	},
	avatarWrapper: {
		width: 80,
		padding: theme.spacing(1),
	},
	muteButtons: {
		paddingLeft: '5px',
		paddingTop: '26px',
		float: 'right',
		display: 'grid',
	},
	left: { float: 'left' },
}));

const defaultlocalLobbySettings: ILobbySettings = {
	maxDistance: 5.32,
	haunting: false,
	hearImpostorsInVents: false,
	impostersHearImpostersInvent: false,
	impostorRadioEnabled: false,
	commsSabotage: false,
	deadOnly: false,
	hearThroughCameras: false,
	wallsBlockAudio: false,
	meetingGhostOnly: false,
	visionHearing: false,
	publicLobby_on: false,
	publicLobby_title: '',
	publicLobby_language: 'en',
};
const radioOnAudio = new Audio();
radioOnAudio.src = radioOnSound;
radioOnAudio.volume = 0.02;

// const radiobeepAudio2 = new Audio();
// radiobeepAudio2.src = radioBeep2;
// radiobeepAudio2.volume = 0.2;

const Voice: React.FC<VoiceProps> = function ({ t, error: initialError }: VoiceProps) {
	const [error, setError] = useState('');
	const [settings, setSetting] = useContext(SettingsContext);

	const settingsRef = useRef<ISettings>(settings);
	const [lobbySettings, setHostLobbySettings] = useContext(HostSettingsContext);
	const lobbySettingsRef = useRef(lobbySettings);
	const maxDistanceRef = useRef(2);
	const gameState = useContext(GameStateContext);
	const playerColors = useContext(PlayerColorContext);

	const hostRef = useRef({
		map: MapType.UNKNOWN,
		mobileRunning: false,
		gamestate: gameState.gameState,
		code: gameState.lobbyCode,
		hostId: gameState.hostId,
		parsedHostId: gameState.hostId,
		isHost: gameState.isHost,
		serverHostId: 0,
	});
	let { lobbyCode: displayedLobbyCode } = gameState;
	if (displayedLobbyCode !== 'MENU' && settings.hideCode) displayedLobbyCode = 'LOBBY';
	const [talking, setTalking] = useState(false);
	// audioId (string) → peer info — replaces BCL's socketClients (socketId → Client)
	const [socketClients, setSocketClients] = useState<SocketClientMap>({});
	const [playerConfigs] = useState<playerConfigMap>(settingsRef.current.playerConfigMap);
	const socketClientsRef = useRef(socketClients);
	// audioId (number) → RTCPeerConnection
	const [peerConnections, setPeerConnections] = useState<PeerConnections>({});
	// audioId → mute/impostorRadio status
	const peerMuteStatus = useRef<{ [audioId: number]: { isMute: boolean; isImpostorRadio: boolean } }>({});
	// my audioId from server
	const myAudioId = useRef<number>(-1);
	// RTCPeerConnection tracks: audioId → MediaStream
	const peerStreams = useRef<{ [audioId: number]: MediaStream }>({});
	const convolverBuffer = useRef<AudioBuffer | null>(null);
	const playerSocketIdsRef = useRef<numberStringMap>({});
	const classes = useStyles();

	const [connect, setConnect] = useState<{
		connect: (lobbyCode: string, playerId: number, clientId: number, isHost: boolean) => void;
	} | null>(null);
	const [otherTalking, setOtherTalking] = useState<ClientBoolMap>({});
	const [otherVAD, setOtherVAD] = useState<ClientBoolMap>({});

	const [otherDead, setOtherDead] = useState<ClientBoolMap>({});
	const impostorRadioClientId = useRef<number>(-1);

	const audioElements = useRef<AudioElements>({});
	const [audioConnected, setAudioConnected] = useState<AudioConnected>({});

	const [deafenedState, setDeafened] = useState(false);
	const [mutedState, setMuted] = useState(false);
	const [connected, setConnected] = useState(false);

	function applyEffect(gain: AudioNode, effectNode: AudioNode, destination: AudioNode, player: Player) {
		console.log('Apply effect->', effectNode);
		try {
			gain.disconnect(destination);
			gain.connect(effectNode);
			effectNode.connect(destination);
		} catch {
			console.log('error with applying effect: ', player.name, effectNode);
		}
	}

	function restoreEffect(gain: AudioNode, effectNode: AudioNode, destination: AudioNode, player: Player) {
		console.log('restore effect->', effectNode);
		try {
			effectNode.disconnect(destination);
			gain.disconnect(effectNode);
			gain.connect(destination);
		} catch {
			console.log('error with applying effect: ', player.name, effectNode);
		}
	}
	function calculateVoiceAudio(
		state: AmongUsState,
		settings: ISettings,
		me: Player,
		other: Player,
		audio: AudioNodes
	): number {
		const { pan, gain, muffle, reverb, destination } = audio;
		const audioContext = pan.context;
		const useLightSource = true;
		let maxdistance = maxDistanceRef.current;
		let panPos = [other.x - me.x, other.y - me.y];
		let endGain = 0;
		let collided = false;
		let skipDistanceCheck = false;
		let muffleEnabled = false;

		if (other.disconnected || other.isDummy) {
			return 0;
		}

		switch (state.gameState) {
			case GameState.MENU:
				return 0;
			case GameState.LOBBY:
				endGain = 1;
				break;

			case GameState.TASKS:
				endGain = 1;

				if (lobbySettings.meetingGhostOnly) {
					endGain = 0;
				}
				if (!me.isDead && lobbySettings.commsSabotage && state.comsSabotaged && !me.isImpostor) {
					endGain = 0;
				}

				// Mute other players which are in a vent
				if (
					other.inVent &&
					!(lobbySettings.hearImpostorsInVents || (lobbySettings.impostersHearImpostersInvent && me.inVent))
				) {
					endGain = 0;
				}
				if (
					lobbySettings.wallsBlockAudio &&
					!me.isDead &&
					poseCollide({ x: me.x, y: me.y }, { x: other.x, y: other.y }, gameState.map, gameState.closedDoors)
				) {
					collided = true;
				}
				if (
					me.isImpostor &&
					other.isImpostor &&
					lobbySettings.impostorRadioEnabled &&
					other.clientId === impostorRadioClientId.current
				) {
					skipDistanceCheck = true;
					muffle.type = 'highpass';
					muffle.frequency.value = 1000;
					muffle.Q.value = 10;
					muffleEnabled = true;
					if (!audio.muffleConnected) {
						audio.muffleConnected = true;
						applyEffect(gain, muffle, destination, other);
					}
				}

				if (!me.isDead && other.isDead && me.isImpostor && lobbySettings.haunting) {
					if (!audio.reverbConnected) {
						audio.reverbConnected = true;
						applyEffect(gain, reverb, destination, other);
					}
					collided = false;
					endGain = settings.ghostVolumeAsImpostor / 100;
				} else {
					if (other.isDead && !me.isDead) {
						endGain = 0;
					}
				}
				break;
			case GameState.DISCUSSION:
				panPos = [0, 0];
				endGain = 1;
				if (!me.isDead && other.isDead) {
					endGain = 0;
				}
				break;

			case GameState.UNKNOWN:
			default:
				endGain = 0;
				break;
		}

		if (useLightSource && state.lightRadiusChanged) {
			pan.maxDistance = maxDistanceRef.current;
		}

		if (!other.isDead || state.gameState !== GameState.TASKS || !me.isImpostor || me.isDead) {
			if (audio.reverbConnected && reverb) {
				audio.reverbConnected = false;
				restoreEffect(gain, reverb, destination, other);
			}
		}

		if (lobbySettings.deadOnly) {
			panPos = [0, 0];
			if (!me.isDead || !other.isDead) {
				endGain = 0;
			}
		}

		let isOnCamera = state.currentCamera !== CameraLocation.NONE;
		if (!skipDistanceCheck && Math.sqrt(panPos[0] * panPos[0] + panPos[1] * panPos[1]) > maxdistance) {
			if (lobbySettings.hearThroughCameras && state.gameState === GameState.TASKS) {
				if (state.currentCamera !== CameraLocation.NONE && state.currentCamera !== CameraLocation.Skeld) {
					const camerapos = AmongUsMaps[state.map].cameras[state.currentCamera];
					panPos = [other.x - camerapos.x, other.y - camerapos.y];
					console.log('camerapos: ', camerapos);
				} else if (state.currentCamera === CameraLocation.Skeld) {
					let distance = 999;
					let camerapos = { x: 999, y: 999 };
					for (const camera of Object.values(AmongUsMaps[state.map].cameras)) {
						const cameraDist = Math.sqrt(Math.pow(other.x - camera.x, 2) + Math.pow(other.y - camera.y, 2));
						if (distance > cameraDist) {
							distance = cameraDist;
							camerapos = camera;
						}
					}
					if (distance != 999) {
						panPos = [other.x - camerapos.x, other.y - camerapos.y];
					}
				}

				if (Math.sqrt(panPos[0] * panPos[0] + panPos[1] * panPos[1]) > maxdistance) {
					return 0;
				}
			} else {
				return 0;
			}
		} else {
			if (collided && !skipDistanceCheck) {
				return 0;
			}
			isOnCamera = false;
		}

		// Muffling in vents
		if (
			((me.inVent && !me.isDead) || (other.inVent && !other.isDead) || isOnCamera) &&
			state.gameState === GameState.TASKS
		) {
			if (!audio.muffleConnected) {
				audio.muffleConnected = true;
				applyEffect(gain, muffle, destination, other);
			}
			maxdistance = isOnCamera ? 3 : 0.8;
			muffle.frequency.value = isOnCamera ? 2300 : 2000;
			muffle.Q.value = isOnCamera ? -15 : 20;
			if (endGain === 1) endGain = isOnCamera ? 0.8 : 0.5; // Too loud at 1
		} else {
			if (audio.muffleConnected && !muffleEnabled) {
				audio.muffleConnected = false;
				restoreEffect(gain, muffle, destination, other);
			}
		}

		if (!settings.enableSpatialAudio || skipDistanceCheck) {
			panPos = [0, 0];
		}

		pan.positionX.setValueAtTime(panPos[0], audioContext.currentTime);
		pan.positionY.setValueAtTime(panPos[1], audioContext.currentTime);
		pan.positionZ.setValueAtTime(-0.5, audioContext.currentTime);
		return endGain;
	}

	function notifyMobilePlayers() {
		if (
			settingsRef.current.mobileHost &&
			hostRef.current.gamestate !== GameState.MENU &&
			hostRef.current.gamestate !== GameState.UNKNOWN
		) {
			// Mobile host relay not used in Interstellar mode
		}
		setTimeout(() => notifyMobilePlayers(), 5000);
	}

	function disconnectAudioHtmlElement(element: HTMLAudioElement) {
		console.log('disableing element?', element);
		element.pause();
		if (element.srcObject) {
			const mediaStream = element.srcObject as MediaStream;
			mediaStream.getTracks().forEach((track) => track.stop());
		}
		element.removeAttribute('srcObject');
		element.removeAttribute('src');
		element.srcObject = null;
		element.load();
		element.remove();
	}
	function disconnectAudioElement(peer: string) {
		if (audioElements.current[peer]) {
			console.log('removing element..');
			disconnectAudioHtmlElement(audioElements.current[peer].audioElement);
			disconnectAudioHtmlElement(audioElements.current[peer].dummyAudioElement);
			audioElements.current[peer].pan.disconnect();
			audioElements.current[peer].gain.disconnect();
			// if (audioElements.current[peer].reverbGain != null) audioElements.current[peer].reverbGain?.disconnect();
			if (audioElements.current[peer].reverb != null) audioElements.current[peer].reverb?.disconnect();
			delete audioElements.current[peer];
		}
	}

	function disconnectClient(client: Client) {
		if (!client || !client.clientId)
			return;
		const oldSocketId = playerSocketIdsRef.current[client.clientId];
		console.log("Checking for  old connection ....", client.clientId, oldSocketId)
		if (oldSocketId && audioElements.current[oldSocketId]) {
			console.log("found old connection disconnecting....", client.clientId)
			disconnectAudioElement(oldSocketId);
		}
	}

	function disconnectPeer(peer: string) {
		console.log('Disconnect peer: ', peer);
		const audioId = parseInt(peer, 10);
		const connection = peerConnections[audioId];
		if (connection) {
			try { connection.close(); } catch (_) { /* ignore */ }
			setPeerConnections((connections) => {
				const next = { ...connections };
				delete next[audioId];
				return next;
			});
		}
		disconnectAudioElement(peer);
	}
	// Handle pushToTalk, if set
	useEffect(() => {
		if (!connectionStuff.current.instream) return;
		connectionStuff.current.instream.getAudioTracks()[0].enabled =
			!connectionStuff.current.deafened &&
			!connectionStuff.current.muted &&
			settings.pushToTalkMode !== pushToTalkOptions.PUSH_TO_TALK;
		connectionStuff.current.pushToTalkMode = settings.pushToTalkMode;
	}, [settings.pushToTalkMode]);

	// Emit lobby settings via Interstellar HostSettings message (host only)
	useEffect(() => {
		if (hostRef.current.isHost !== true) return;
		setHostLobbySettings(settings.localLobbySettings);
		// Send HostSettings via WebSocket to Interstellar server
		sendInterstellarHostSettings(settings.localLobbySettings);
	}, [settings.localLobbySettings, hostRef.current.isHost]);

	useEffect(() => {
		for (const peer in audioElements.current) {
			audioElements.current[peer].pan.maxDistance = maxDistanceRef.current;
		}
	}, [lobbySettings.maxDistance, lobbySettings.visionHearing]);

	useEffect(() => {
		if (
			!gameState ||
			!gameState.players ||
			!settings.obsOverlay
		) {
			return;
		}

		// Mobile host relay removed (Interstellar handles server-side)

		if (
			settings.obsOverlay &&
			settings.obsSecret &&
			settings.obsSecret.length === 9 &&
			((gameState.gameState !== GameState.UNKNOWN && gameState.gameState !== GameState.MENU) ||
				gameState.oldGameState !== gameState.gameState)
		) {
			const obsvoiceState: ObsVoiceState = {
				overlayState: {
					gameState: gameState.gameState,
					players: gameState.players.map((o) => ({
						id: o.id,
						clientId: o.clientId,
						inVent: o.inVent,
						isDead: o.isDead,
						name: o.name,
						colorId: o.colorId,
						hatId: o.hatId,
						petId: o.petId,
						skinId: o.skinId,
						visorId: o.visorId,
						disconnected: o.disconnected,
						isLocal: o.isLocal,
						shiftedColor: o.shiftedColor,
						bugged: o.bugged,
						realColor: playerColors[o.colorId],
						usingRadio: o.clientId === impostorRadioClientId.current && myPlayer?.isImpostor,
						connected:
							(playerSocketIdsRef.current[o.clientId] &&
								socketClients[playerSocketIdsRef.current[o.clientId]]?.clientId === o.clientId) ||
							false,
					})),
				},
				otherTalking,
				otherDead,
				localTalking: talking,
				localIsAlive: !myPlayer?.isDead,
				mod: gameState.mod,
				oldMeetingHud: gameState.oldMeetingHud,
			};
			// OBS overlay via IPC (no socket.io)
			ipcRenderer.send(IpcMessages.SEND_TO_OVERLAY, IpcOverlayMessages.NOTIFY_VOICE_STATE_CHANGED, obsvoiceState);
		}
	}, [gameState]);

	// Add settings to settingsRef
	useEffect(() => {
		settingsRef.current = settings;
	}, [settings]);

	// Add socketClients to socketClientsRef
	useEffect(() => {
		socketClientsRef.current = socketClients;
	}, [socketClients]);

	useEffect(() => {
		if (
			connectionStuff.current?.microphoneGain?.gain &&
			(settingsRef.current.microphoneGainEnabled || settingsRef.current.micSensitivityEnabled)
		) {
			if (!settingsRef.current.micSensitivityEnabled)
				connectionStuff.current.microphoneGain.gain.value = settings.microphoneGainEnabled
					? settings.microphoneGain / 100
					: 1;

			if (connectionStuff.current?.audioListener?.options) {
				connectionStuff.current.audioListener.options.minNoiseLevel = settings.micSensitivity;
				connectionStuff.current.audioListener.init();
			}
		}
	}, [settings.microphoneGain, settings.micSensitivity]);

	const updateLobby = () => {
		console.log(gameState);
		if (
			!gameState ||
			!hostRef.current.isHost ||
			!gameState.lobbyCode ||
			gameState.gameState === GameState.MENU ||
			!gameState.players
		) {
			return;
		}
		// Public lobby not supported yet in Interstellar mode
	};

	useEffect(() => {
		if (gameState.isHost && gameState.hostId > 0) {
			hostRef.current.serverHostId = gameState.hostId;
		}
	}, [gameState.isHost]);

	useEffect(() => {
		updateLobby();
	}, [
		gameState.gameState,
		gameState?.players?.length,
		lobbySettings.publicLobby_title,
		lobbySettings.publicLobby_language,
		lobbySettings.publicLobby_on,
	]);

	// Add lobbySettings to lobbySettingsRef
	useEffect(() => {
		lobbySettingsRef.current = lobbySettings;
	}, [lobbySettings]);



	// Set dead player data
	useEffect(() => {
		if (gameState.gameState === GameState.LOBBY) {
			setOtherDead({});
		} else if (gameState.gameState !== GameState.TASKS) {
			if (!gameState.players) return;
			setOtherDead((old) => {
				for (const player of gameState.players) {
					old[player.clientId] = player.isDead || player.disconnected;
				}
				return { ...old };
			});
		}
	}, [gameState.gameState]);

	// const [audioContext] = useState<AudioContext>(() => new AudioContext());
	const connectionStuff = useRef<ConnectionStuff>({
		pushToTalkMode: settings.pushToTalkMode,
		deafened: false,
		muted: false,
		impostorRadio: null,
		toggleMute: () => {
			/*empty*/
		},
		toggleDeafen: () => {
			/*empty*/
		},
	});

	useEffect(() => {
		(async () => {
			const context = new AudioContext();
			convolverBuffer.current = await context.decodeAudioData(reverbOgx);
			await context.close();
		})();
	}, []);

	useEffect(() => {
		const pressing = connectionStuff.current.impostorRadio;
		if (
			pressing == null ||
			!myPlayer ||
			!myPlayer.isImpostor ||
			myPlayer.isDead ||
			!(impostorRadioClientId.current === myPlayer.clientId || impostorRadioClientId.current === -1) ||
			!lobbySettingsRef.current.impostorRadioEnabled
		) {
			return;
		}
		radioOnAudio.play();
		connectionStuff.current.impostorRadio = pressing;
		impostorRadioClientId.current = pressing ? myPlayer.clientId : -1;
		// Notify Interstellar server of impostor radio state
		if (connectionStuff.current.ws?.readyState === WebSocket.OPEN) {
			wsSendMuteStatus(connectionStuff.current.ws, connectionStuff.current.muted ?? false, pressing);
		}
	}, [connectionStuff.current.impostorRadio]);

	// ── Interstellar Protocol Helpers ──────────────────────────────────────────
	// Build a binary WebSocket message per Interstellar MessagePacker format:
	//   byte[0] = message count (always 1 for client → server)
	//   byte[1] = MessageTag
	//   ... payload bytes
	function encodeString(str: string): Uint8Array {
		const encoded = new TextEncoder().encode(str);
		const buf = new Uint8Array(4 + encoded.byteLength);
		new DataView(buf.buffer).setInt32(0, encoded.byteLength, true);
		buf.set(encoded, 4);
		return buf;
	}

	function concatBuffers(...bufs: Uint8Array[]): Uint8Array {
		const total = bufs.reduce((s, b) => s + b.byteLength, 0);
		const out = new Uint8Array(total);
		let off = 0;
		for (const b of bufs) { out.set(b, off); off += b.byteLength; }
		return out;
	}

	function packMsg(tag: number, ...payloadParts: Uint8Array[]): ArrayBuffer {
		const payload = concatBuffers(...payloadParts);
		const buf = new Uint8Array(2 + payload.byteLength);
		buf[0] = 1; // message count
		buf[1] = tag;
		buf.set(payload, 2);
		return buf.buffer;
	}

	function u8(v: number): Uint8Array { return new Uint8Array([v & 0xff]); }
	function f32LE(v: number): Uint8Array {
		const b = new Uint8Array(4);
		new DataView(b.buffer).setFloat32(0, v, true);
		return b;
	}
	function u16LE(v: number): Uint8Array {
		const b = new Uint8Array(2);
		new DataView(b.buffer).setUint16(0, v, true);
		return b;
	}

	// Send Join message: tag=0, roomCode (string), region (string)
	function wsSendJoin(ws: WebSocket, roomCode: string, region: string) {
		ws.send(packMsg(MsgTag.Join, encodeString(roomCode), encodeString(region)));
	}

	// Send Profile message: tag=1, playerName (string), playerId (byte)
	function wsSendProfile(ws: WebSocket, playerName: string, playerId: number) {
		ws.send(packMsg(MsgTag.Profile, encodeString(playerName), u8(playerId)));
	}

	// Send SDP Answer: tag=3, sdp (string gzip-compressed in Interstellar, but server also accepts plain)
	function wsSendSdpAnswer(ws: WebSocket, sdp: string) {
		ws.send(packMsg(MsgTag.SdpAnswer, encodeString(sdp)));
	}

	// Send ICE candidate: tag=4, candidate, sdpMid, sdpMLineIndex, usernameFragment
	function wsSendIceCand(ws: WebSocket, candidate: string, sdpMid: string, sdpMLineIndex: number, usernameFragment: string) {
		ws.send(packMsg(MsgTag.AddIceCand,
			encodeString(candidate),
			encodeString(sdpMid),
			u16LE(sdpMLineIndex),
			encodeString(usernameFragment)));
	}

	// Send UpdateMuteStatus: tag=10, isMute (bool byte), isImpostorRadio (bool byte)
	function wsSendMuteStatus(ws: WebSocket, isMute: boolean, isImpostorRadio = false) {
		ws.send(packMsg(MsgTag.UpdateMuteStatus, u8(isMute ? 1 : 0), u8(isImpostorRadio ? 1 : 0)));
	}

	// Send HostSettings: tag=12, maxChatDistance (f32 LE), flagsLow (byte), flagsHigh (byte)
	const sendInterstellarHostSettings = (ls: ILobbySettings) => {
		const ws = connectionStuff.current.ws;
		if (!ws || ws.readyState !== WebSocket.OPEN) return;
		let flags = 0;
		if (ls.wallsBlockAudio)               flags |= 1;
		if (ls.visionHearing)                  flags |= 2;
		if (ls.haunting)                        flags |= 4;
		if (ls.deadOnly)                        flags |= 8;
		if (ls.hearImpostorsInVents)            flags |= 16;
		if (ls.impostersHearImpostersInvent)    flags |= 32;
		if (ls.commsSabotage)                   flags |= 64;
		if (ls.hearThroughCameras)              flags |= 128;
		if (ls.impostorRadioEnabled)            flags |= 256;
		if (ls.meetingGhostOnly)                flags |= 512;
		// hearVentPlayers = 1024 (no direct BCL equivalent, leave 0)
		ws.send(packMsg(MsgTag.HostSettings,
			f32LE(ls.maxDistance),
			u8(flags & 0xff),
			u8((flags >> 8) & 0xff)));
	};

	// ── Parse incoming Interstellar binary messages ──────────────────────────
	function readString(view: DataView, offset: number): { value: string; bytesRead: number } {
		const len = view.getInt32(offset, true);
		offset += 4;
		if (len < 0) return { value: '', bytesRead: 4 };
		const bytes = new Uint8Array(view.buffer, offset, len);
		return { value: new TextDecoder().decode(bytes), bytesRead: 4 + len };
	}
	function readBool(view: DataView, offset: number): { value: boolean; bytesRead: number } {
		return { value: view.getUint8(offset) !== 0, bytesRead: 1 };
	}
	function readByte(view: DataView, offset: number): { value: number; bytesRead: number } {
		return { value: view.getUint8(offset), bytesRead: 1 };
	}
	function readInt32(view: DataView, offset: number): { value: number; bytesRead: number } {
		return { value: view.getInt32(offset, true), bytesRead: 4 };
	}
	function readFloat(view: DataView, offset: number): { value: number; bytesRead: number } {
		return { value: view.getFloat32(offset, true), bytesRead: 4 };
	}
	function readUint16(view: DataView, offset: number): { value: number; bytesRead: number } {
		return { value: view.getUint16(offset, true), bytesRead: 2 };
	}

	// ── ICE configuration ─────────────────────────────────────────────────────
	const DEFAULT_ICE_CONFIG: RTCConfiguration = {
		iceTransportPolicy: 'all',
		iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
	};

	useEffect(() => {
		let currentLobby = '';
		let pendingJoin: { roomCode: string; playerId: number; clientId: number } | null = null;
		let myPlayerId = 0;
		let myClientId = 0;

		// Map audioId (number) → { playerName, playerId, clientId }
		const peerProfiles = new Map<number, InterstellarPeerInfo>();
		// audioId → RTCPeerConnection (local ref for closure)
		const rtcPeers = new Map<number, RTCPeerConnection>();

		// ── Convert serverURL (http/https) to WebSocket URL ──────────────────
		const rawUrl = settingsRef.current.serverURL.trim().replace(/\/$/, '');
		const wsUrl = rawUrl.replace(/^http/, 'ws') + '/vc';

		const ws = new WebSocket(wsUrl);
		ws.binaryType = 'arraybuffer';
		connectionStuff.current.ws = ws;

		function updateClientMapFromProfiles() {
			const newMap: SocketClientMap = {};
			for (const [audioId, info] of peerProfiles.entries()) {
				const key = String(audioId);
				newMap[key] = {
					clientId: info.clientId,
					playerId: info.playerId,
					name: info.playerName,
				} as Client;
			}
			setSocketClients(newMap);
		}

		ws.onopen = () => {
			setConnected(true);
			console.log('[StarLink] WebSocket connected to', wsUrl);
			if (pendingJoin) {
				const { roomCode, playerId, clientId } = pendingJoin;
				pendingJoin = null;
				wsSendJoin(ws, roomCode, gameState.currentServer ?? 'NA');
				wsSendProfile(ws, gameState.players?.find(p => p.isLocal)?.name ?? '', playerId);
			}
		};

		ws.onerror = (e) => {
			console.error('[StarLink] WebSocket error', e);
			setError('Could not connect to voice server: ' + wsUrl);
		};

		ws.onclose = (e) => {
			setConnected(false);
			currentLobby = 'MENU';
			console.warn('[StarLink] WebSocket closed', e.code, e.reason);
		};

		// ── Handle incoming binary messages ───────────────────────────────────
		ws.onmessage = (event: MessageEvent) => {
			if (!(event.data instanceof ArrayBuffer)) return;
			const view = new DataView(event.data);
			const msgCount = view.getUint8(0);
			let offset = 1;

			for (let i = 0; i < msgCount; i++) {
				if (offset >= view.byteLength) break;
				const tag: MsgTag = view.getUint8(offset);
				offset += 1;

				switch (tag) {
					case MsgTag.ShareId: {
						// Server assigns our audioId
						const r = readInt32(view, offset);
						myAudioId.current = r.value;
						offset += r.bytesRead;
						console.log('[StarLink] Got audioId:', r.value);
						break;
					}

					case MsgTag.SdpOffer: {
						// Server sends SDP offer + bitmask of active audioIds
						// Format: int64 mask (8 bytes LE) + string sdp
						if (offset + 8 > view.byteLength) break;
						// mask low/high 32-bit words
						const maskLo = view.getUint32(offset, true);
						const maskHi = view.getUint32(offset + 4, true);
						offset += 8;
						const sdpR = readString(view, offset);
						offset += sdpR.bytesRead;
						const sdp = sdpR.value;

						(async () => {
							// Determine which audioIds are active
							const activeIds: number[] = [];
							for (let bit = 0; bit < 32; bit++) {
								if (maskLo & (1 << bit)) activeIds.push(bit);
							}
							for (let bit = 0; bit < 32; bit++) {
								if (maskHi & (1 << bit)) activeIds.push(32 + bit);
							}

							// Accumulate tracks: one per audioId in mask
							// We create a single RTCPeerConnection shared with server
							// (Interstellar uses one RTCPeerConnection per client on the server side,
							//  but here we need ONE per remote audioId track)
							// Actually Interstellar server sends ONE SDP offer total with multiple tracks.
							// We use a single "main" RTCPeerConnection keyed as audioId=-1 in the map.
							const mainPcKey = -1;
							let pc = rtcPeers.get(mainPcKey);
							if (!pc) {
								pc = new RTCPeerConnection(DEFAULT_ICE_CONFIG);
								rtcPeers.set(mainPcKey, pc);

								pc.onicecandidate = (ev) => {
									if (ev.candidate && ws.readyState === WebSocket.OPEN) {
										wsSendIceCand(ws,
											ev.candidate.candidate,
											ev.candidate.sdpMid ?? '',
											ev.candidate.sdpMLineIndex ?? 0,
											ev.candidate.usernameFragment ?? '');
									}
								};

								pc.ontrack = (ev) => {
									// Interstellar uses formatID (audioId) to label tracks
									// The RTP payload type / SSRC encodes audioId
									// We look at the transceiver mid or track id
									const stream = ev.streams[0];
									if (!stream) return;
									// Try to map stream/track to audioId via active profiles
									// The track label or stream id may not reliably carry audioId here,
									// so we match by arrival order to activeIds
									handleRemoteTrack(ev.track, stream);
								};
							}

							await pc.setRemoteDescription({ type: 'offer', sdp });
							const answer = await pc.createAnswer();
							await pc.setLocalDescription(answer);
							if (ws.readyState === WebSocket.OPEN) {
								wsSendSdpAnswer(ws, answer.sdp ?? '');
							}

							// Register RTCPeerConnections per audioId for audio routing
							for (const aid of activeIds) {
								if (!rtcPeers.has(aid)) {
									rtcPeers.set(aid, pc!);
									setPeerConnections(prev => ({ ...prev, [aid]: pc! }));
								}
							}
						})();
						break;
					}

					case MsgTag.AddIceCand: {
						const candR = readString(view, offset); offset += candR.bytesRead;
						const midR = readString(view, offset); offset += midR.bytesRead;
						const mlineR = readUint16(view, offset); offset += mlineR.bytesRead;
						const fragR = readString(view, offset); offset += fragR.bytesRead;

						const mainPc = rtcPeers.get(-1);
						if (mainPc) {
							mainPc.addIceCandidate({
								candidate: candR.value,
								sdpMid: midR.value,
								sdpMLineIndex: mlineR.value,
								usernameFragment: fragR.value,
							}).catch(e => console.warn('[StarLink] addIceCandidate error', e));
						}
						break;
					}

					case MsgTag.ShareProfile: {
						// Server broadcasts a peer's profile
						// Format: byte audioId, byte playerId, string playerName
						const audioIdR = readByte(view, offset); offset += audioIdR.bytesRead;
						const playerIdR = readByte(view, offset); offset += playerIdR.bytesRead;
						const nameR = readString(view, offset); offset += nameR.bytesRead;
						const audioId = audioIdR.value;

						// Find Among Us clientId by matching playerName to known players
						const matchingPlayer = gameState.players?.find(p => p.name === nameR.value);
						const resolvedClientId = matchingPlayer?.clientId ?? 0;

						peerProfiles.set(audioId, {
							audioId,
							playerName: nameR.value,
							playerId: playerIdR.value,
							clientId: resolvedClientId,
						} as InterstellarPeerInfo & { audioId: number });
						updateClientMapFromProfiles();
						console.log('[StarLink] Peer profile:', audioId, nameR.value, 'clientId=', resolvedClientId);
						break;
					}

					case MsgTag.NoticeDisconnect: {
						const clientIdR = readInt32(view, offset); offset += clientIdR.bytesRead;
						const disconnectedAudioId = clientIdR.value;
						peerProfiles.delete(disconnectedAudioId);
						rtcPeers.delete(disconnectedAudioId);
						peerMuteStatus.current[disconnectedAudioId] && delete peerMuteStatus.current[disconnectedAudioId];
						disconnectPeer(String(disconnectedAudioId));
						updateClientMapFromProfiles();
						break;
					}

					case MsgTag.ShareMuteStatus: {
						const aidR = readByte(view, offset); offset += aidR.bytesRead;
						const isMuteR = readBool(view, offset); offset += isMuteR.bytesRead;
						let isRadio = false;
						if (offset < view.byteLength) {
							const radioR = readBool(view, offset); offset += radioR.bytesRead;
							isRadio = radioR.value;
						}
						peerMuteStatus.current[aidR.value] = { isMute: isMuteR.value, isImpostorRadio: isRadio };
						if (isRadio) {
							const profile = peerProfiles.get(aidR.value);
							if (profile) {
								impostorRadioClientId.current = isMuteR.value ? profile.clientId : -1;
							}
						}
						break;
					}

					case MsgTag.HostSettings: {
						// Server relays host settings to all clients
						const maxDistR = readFloat(view, offset); offset += maxDistR.bytesRead;
						const flagsLo = view.getUint8(offset++);
						const flagsHi = view.getUint8(offset++);
						const flags = flagsLo | (flagsHi << 8);
						const newSettings: ILobbySettings = {
							...defaultlocalLobbySettings,
							maxDistance: maxDistR.value,
							wallsBlockAudio:             (flags & 1) !== 0,
							visionHearing:                (flags & 2) !== 0,
							haunting:                    (flags & 4) !== 0,
							deadOnly:                    (flags & 8) !== 0,
							hearImpostorsInVents:         (flags & 16) !== 0,
							impostersHearImpostersInvent: (flags & 32) !== 0,
							commsSabotage:                (flags & 64) !== 0,
							hearThroughCameras:           (flags & 128) !== 0,
							impostorRadioEnabled:         (flags & 256) !== 0,
							meetingGhostOnly:             (flags & 512) !== 0,
						};
						setHostLobbySettings(newSettings);
						break;
					}

					case MsgTag.ServerInfo: {
						// Skip: optimalPlayers (int32), currentCount (int32), vcUrl (string)
						offset += 4 + 4;
						const urlR = readString(view, offset); offset += urlR.bytesRead;
						break;
					}

					default:
						// Unknown tag — stop parsing this message batch
						offset = view.byteLength;
						break;
				}
			}
		};

		// ── Audio pipeline for remote tracks ─────────────────────────────────
		function handleRemoteTrack(track: MediaStreamTrack, stream: MediaStream) {
			// We need to map this track to an audioId.
			// Interstellar uses RTP FormatID == audioId. In browser WebRTC we can't
			// directly read FormatID, but each peer has a separate stream.
			// We match streams by order: first unregistered audioId in peerProfiles.
			// Find first audioId with no audio element yet
			let assignedAudioId = -1;
			for (const [aid] of peerProfiles.entries()) {
				if (aid !== myAudioId.current && !audioElements.current[String(aid)]) {
					assignedAudioId = aid;
					break;
				}
			}
			if (assignedAudioId === -1) {
				// No profile known yet — store stream for later assignment
				peerStreams.current[-1 - Object.keys(peerStreams.current).length] = stream;
				return;
			}

			attachAudioStream(String(assignedAudioId), stream);
		}

		function attachAudioStream(peer: string, stream: MediaStream) {
			setAudioConnected((old) => ({ ...old, [peer]: true }));
			const dummyAudio = new Audio();
			dummyAudio.srcObject = stream;
			const context = new AudioContext();
			const source = context.createMediaStreamSource(stream);
			const dest = context.createMediaStreamDestination();

			const gain = context.createGain();
			const pan = context.createPanner();
			gain.gain.value = 0;
			pan.refDistance = 0.1;
			pan.panningModel = 'equalpower';
			pan.distanceModel = 'linear';
			pan.maxDistance = maxDistanceRef.current;
			pan.rolloffFactor = 1;

			const muffle = context.createBiquadFilter();
			muffle.type = 'lowpass';

			source.connect(pan);
			pan.connect(gain);

			const reverb = context.createConvolver();
			reverb.buffer = convolverBuffer.current;
			const destination: AudioNode = dest;
			gain.connect(destination);

			const audio = document.createElement('audio') as ExtendedAudioElement;
			document.body.appendChild(audio);
			audio.setAttribute('autoplay', '');
			audio.srcObject = dest.stream;
			if (settingsRef.current.speaker.toLowerCase() !== 'default') {
				audio.setSinkId(settingsRef.current.speaker);
			}

			audioElements.current[peer] = {
				dummyAudioElement: dummyAudio,
				audioElement: audio,
				gain,
				pan,
				reverb,
				muffle,
				muffleConnected: false,
				reverbConnected: false,
				destination,
			};
		}

		// ── Microphone capture & send ─────────────────────────────────────────
		let audioListener: VadNode;

		const audio: MediaTrackConstraintSet = {
			deviceId: (undefined as unknown) as string,
			autoGainControl: false,
			channelCount: 1, // mono — saves CPU vs stereo for voice
			echoCancellation: settingsRef.current.echoCancellation,
			latency: 0,
			noiseSuppression: settingsRef.current.noiseSuppression,
			// @ts-ignore-line
			googNoiseSuppression: settingsRef.current.noiseSuppression,
			// @ts-ignore-line
			googEchoCancellation: settingsRef.current.echoCancellation,
			// @ts-ignore-line
			googTypingNoiseDetection: settingsRef.current.noiseSuppression,
			sampleRate: settingsRef.current.oldSampleDebug ? 48000 : undefined,
			sampleSize: settingsRef.current.oldSampleDebug ? 16 : undefined,
		};

		if (settingsRef.current.microphone.toLowerCase() !== 'default') audio.deviceId = settingsRef.current.microphone;

		navigator.mediaDevices.getUserMedia({ video: false, audio })
		.then(async (inStream) => {
			let stream = inStream;
			const ac = new AudioContext();
			let microphoneGain: GainNode | undefined;
			const source = ac.createMediaStreamSource(inStream);
			if (settingsRef.current.microphoneGainEnabled || settingsRef.current.micSensitivityEnabled) {
				microphoneGain = ac.createGain();
				const destination = ac.createMediaStreamDestination();
				source.connect(microphoneGain);
				microphoneGain.gain.value = settingsRef.current.microphoneGainEnabled
					? settingsRef.current.microphoneGain / 100
					: 1;
				microphoneGain.connect(destination);
				connectionStuff.current.microphoneGain = microphoneGain;
				stream = destination.stream;
			}

			if (settingsRef.current.vadEnabled) {
				audioListener = VAD(ac, source, undefined, {
					onVoiceStart: () => {
						if (microphoneGain && settingsRef.current.micSensitivityEnabled) {
							microphoneGain.gain.value = settingsRef.current.microphoneGainEnabled
								? settingsRef.current.microphoneGain / 100
								: 1;
						}
						setTalking(true);
					},
					onVoiceStop: () => {
						if (microphoneGain && settingsRef.current.micSensitivityEnabled) {
							microphoneGain.gain.value = 0;
						}
						setTalking(false);
					},
					noiseCaptureDuration: 0,
					stereo: false,
				});

				audioListener.options.minNoiseLevel = settingsRef.current.micSensitivityEnabled
					? settingsRef.current.micSensitivity
					: 0.15;
				audioListener.options.maxNoiseLevel = 1;
				audioListener.init();
				connectionStuff.current.audioListener = audioListener;
				connectionStuff.current.microphoneGain = microphoneGain;
			}
			connectionStuff.current.stream = stream;
			connectionStuff.current.instream = inStream;

			inStream.getAudioTracks()[0].enabled =
				settingsRef.current.pushToTalkMode !== pushToTalkOptions.PUSH_TO_TALK;

			connectionStuff.current.toggleDeafen = () => {
				connectionStuff.current.deafened = !connectionStuff.current.deafened;
				inStream.getAudioTracks()[0].enabled =
					!connectionStuff.current.deafened &&
					!connectionStuff.current.muted &&
					connectionStuff.current.pushToTalkMode !== pushToTalkOptions.PUSH_TO_TALK;
				setDeafened(connectionStuff.current.deafened);
			};

			connectionStuff.current.toggleMute = () => {
				connectionStuff.current.muted = !connectionStuff.current.muted;
				if (connectionStuff.current.deafened) {
					connectionStuff.current.deafened = false;
					connectionStuff.current.muted = false;
				}
				inStream.getAudioTracks()[0].enabled =
					!connectionStuff.current.muted &&
					!connectionStuff.current.deafened &&
					connectionStuff.current.pushToTalkMode !== pushToTalkOptions.PUSH_TO_TALK;
				setMuted(connectionStuff.current.muted);
				setDeafened(connectionStuff.current.deafened);
				// Notify server of mute status
				if (ws.readyState === WebSocket.OPEN) {
					wsSendMuteStatus(ws, connectionStuff.current.muted);
				}
			};

			ipcRenderer.on(IpcRendererMessages.TOGGLE_DEAFEN, connectionStuff.current.toggleDeafen);

			ipcRenderer.on(IpcRendererMessages.IMPOSTOR_RADIO, (_: unknown, pressing: boolean) => {
				connectionStuff.current.impostorRadio = pressing;
				if (ws.readyState === WebSocket.OPEN) {
					wsSendMuteStatus(ws, connectionStuff.current.muted ?? false, pressing);
				}
			});

			ipcRenderer.on(IpcRendererMessages.TOGGLE_MUTE, connectionStuff.current.toggleMute);
			ipcRenderer.on(IpcRendererMessages.PUSH_TO_TALK, (_: unknown, pressing: boolean) => {
				if (connectionStuff.current.pushToTalkMode === pushToTalkOptions.VOICE) return;
				if (!connectionStuff.current.deafened && !connectionStuff.current.muted) {
					inStream.getAudioTracks()[0].enabled =
						connectionStuff.current.pushToTalkMode === pushToTalkOptions.PUSH_TO_TALK
							? pressing
							: !pressing;
				}
			});

			audioElements.current = {};

			// ── connect(): join a room on the Interstellar server ────────────
			const connect = (lobbyCode: string, playerId: number, clientId: number, isHost: boolean) => {
				console.log('[StarLink] connect called', lobbyCode);
				setOtherVAD({});
				setOtherTalking({});
				myPlayerId = playerId;
				myClientId = clientId;

				if (lobbyCode === 'MENU') {
					for (const [aid] of rtcPeers.entries()) {
						disconnectPeer(String(aid));
					}
					rtcPeers.clear();
					peerProfiles.clear();
					setSocketClients({});
					currentLobby = lobbyCode;
				} else if (currentLobby !== lobbyCode) {
					currentLobby = lobbyCode;
					if (ws.readyState === WebSocket.OPEN) {
						wsSendJoin(ws, lobbyCode, gameState.currentServer ?? 'NA');
						const localPlayer = gameState.players?.find(p => p.isLocal);
						if (localPlayer) {
							wsSendProfile(ws, localPlayer.name, playerId);
						}
					} else {
						pendingJoin = { roomCode: lobbyCode, playerId, clientId };
					}
				}
			};

			setConnect({ connect });

		},
		(error) => {
			console.error(error);
			setError("Couldn't connect to your microphone:\n" + error);
		});

		return () => {
			hostRef.current.mobileRunning = false;
			if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
				ws.close();
			}
			for (const [aid] of rtcPeers.entries()) {
				disconnectPeer(String(aid));
			}
			rtcPeers.clear();
			connectionStuff.current.ws = undefined;
			audioListener?.destroy();
		};
	}, []);


	interface mobileHostInfo {
		mobilePlayerInfo: {
			code: string;
			askingForHost: boolean;
		};
	}

	//data: { mobilePlayerInfo: { code: this.gamecode, askingForHost: true }
	const myPlayer = useMemo(() => {
		if (!gameState || !gameState.players) {
			return undefined;
		} else {
			return gameState.players.find((p) => p.isLocal);
		}
	}, [gameState.players]);

	const otherPlayers = useMemo(() => {
		let otherPlayers: Player[];
		if (!gameState || !gameState.players || !myPlayer) return [];
		else otherPlayers = gameState.players.filter((p) => !p.isLocal);
		maxDistanceRef.current = lobbySettings.visionHearing
			? myPlayer.isImpostor
				? lobbySettings.maxDistance
				: gameState.lightRadius + 0.5
			: lobbySettings.maxDistance;
		if (maxDistanceRef.current <= 0.6) {
			maxDistanceRef.current = 1;
		}
		hostRef.current = {
			map: gameState.map,
			mobileRunning: hostRef.current.mobileRunning,
			gamestate: gameState.gameState,
			code: gameState.lobbyCode,
			hostId: gameState.hostId,
			isHost: gameState.hostId > 0 ? gameState.isHost : hostRef.current.serverHostId === gameState.clientId,
			parsedHostId: gameState.hostId > 0 ? gameState.hostId : hostRef.current.serverHostId,
			serverHostId: hostRef.current.serverHostId,
		};
		const playerSocketIds: numberStringMap = {};
		for (const k of Object.keys(socketClients)) {
			playerSocketIds[socketClients[k].clientId] = k;
		}
		playerSocketIdsRef.current = playerSocketIds;
		const handledPeerIds: string[] = [];
		let foundRadioUser = false;
		const tempTalking = { ...otherTalking };
		let talkingUpdate = false;
		for (const player of otherPlayers) {
			const peerId = playerSocketIds[player.clientId];
			const audio = player.clientId === myPlayer.clientId ? undefined : audioElements.current[peerId];
			if (
				player.clientId === impostorRadioClientId.current &&
				player.isImpostor &&
				!player.isDead &&
				!player.disconnected &&
				!player.bugged
			) {
				foundRadioUser = true;
			}
			if (audio) {
				handledPeerIds.push(peerId);
				let gain = calculateVoiceAudio(gameState, settingsRef.current, myPlayer, player, audio);
				if (connectionStuff.current.deafened || playerConfigs[player.nameHash]?.isMuted) {
					gain = 0;
				}

				if (gain > 0) {
					const playerVolume = playerConfigs[player.nameHash]?.volume;
					gain = playerVolume === undefined ? gain : gain * playerVolume;

					if (myPlayer.isDead && !player.isDead) {
						gain = gain * (settings.crewVolumeAsGhost / 100);
					}
					gain = gain * (settings.masterVolume / 100);
				}
				audio.gain.gain.value = gain;
				tempTalking[player.clientId] = otherVAD[player.clientId] && gain > 0;
				if (tempTalking[player.clientId] != otherTalking[player.clientId]) {
					talkingUpdate = true;
				}
			}
		}
		if (talkingUpdate) {
			setOtherTalking(tempTalking);
		}

		if (
			((!foundRadioUser && impostorRadioClientId.current !== myPlayer.clientId) || !myPlayer.isImpostor) &&
			impostorRadioClientId.current !== -1
		) {
			impostorRadioClientId.current = -1;
		}
		for (const peerId in Object.keys(audioElements.current).filter((e) => !handledPeerIds.includes(e))) {
			const audio = audioElements.current[peerId];
			if (audio && audio.gain) {
				audio.gain.gain.value = 0;
			}
			// maybe disconnect later
		}

		return otherPlayers;
	}, [gameState]);

	// Connect to P2P negotiator, when lobby and connect code change
	useEffect(() => {
		if (connect?.connect) {
			connect.connect(gameState?.lobbyCode ?? 'MENU', myPlayer?.id ?? 0, gameState.clientId, gameState.isHost);
			updateLobby();
		}
	}, [connect?.connect, gameState?.lobbyCode, connected]);

	useEffect(() => {
		if (myPlayer?.shiftedColor != -1) {
			// Mute via Interstellar UpdateMuteStatus
			if (connectionStuff.current.ws?.readyState === WebSocket.OPEN) {
				wsSendMuteStatus(connectionStuff.current.ws, true);
			}
			setTalking(false);
		}
	}, [myPlayer?.shiftedColor]);

	useEffect(() => {
		// VAD: notify server of mute state when talking changes
		if (connectionStuff.current.ws?.readyState === WebSocket.OPEN) {
			wsSendMuteStatus(connectionStuff.current.ws, !talking, connectionStuff.current.impostorRadio ?? false);
		}
	}, [talking]);

	// Connect to voice server when game state changes
	useEffect(() => {
		if (
			connect?.connect &&
			gameState.lobbyCode &&
			myPlayer?.clientId !== undefined &&
			gameState.gameState === GameState.LOBBY &&
			(gameState.oldGameState === GameState.DISCUSSION || gameState.oldGameState === GameState.TASKS)
		) {
			hostRef.current.mobileRunning = false;
			connect.connect(gameState.lobbyCode, myPlayer.clientId, gameState.clientId, gameState.isHost);
		} else if (
			gameState.oldGameState !== GameState.UNKNOWN &&
			gameState.oldGameState !== GameState.MENU &&
			gameState.gameState === GameState.MENU
		) {
			console.log('[StarLink] DISCONNECT TO MENU!');
			hostRef.current.mobileRunning = false;
			// Close WebSocket — server will clean up the room
			if (connectionStuff.current.ws?.readyState === WebSocket.OPEN) {
				connectionStuff.current.ws.close();
			}
			Object.keys(peerConnections).forEach((k) => {
				disconnectPeer(k);
			});
			setOtherDead({});
		}
	}, [gameState.gameState]);

	// Update profile on Interstellar server when player changes
	useEffect(() => {
		if (connectionStuff.current.ws?.readyState === WebSocket.OPEN && myPlayer && myPlayer.clientId !== undefined) {
			wsSendProfile(connectionStuff.current.ws, myPlayer.name, myPlayer.id);
		}
	}, [myPlayer?.id, myPlayer?.clientId, myPlayer?.name]);

	// Pass voice state to overlay
	useEffect(() => {
		if (!settings.enableOverlay) {
			return;
		}
		ipcRenderer.send(IpcMessages.SEND_TO_OVERLAY, IpcOverlayMessages.NOTIFY_VOICE_STATE_CHANGED, {
			otherTalking,
			playerSocketIds: playerSocketIdsRef.current,
			otherDead,
			socketClients,
			audioConnected,
			localTalking: talking,
			localIsAlive: !myPlayer?.isDead,
			impostorRadioClientId: !myPlayer?.isImpostor ? -1 : impostorRadioClientId.current,
			muted: mutedState,
			deafened: deafenedState,
			mod: gameState.mod,
		} as VoiceState);
	}, [
		otherTalking,
		otherDead,
		socketClients,
		audioConnected,
		talking,
		mutedState,
		deafenedState,
		impostorRadioClientId.current,
	]);

	return (
		<div className={classes.root}>
			{(error || initialError) && (
				<div className={classes.error}>
					<Typography align="center" variant="h6" color="error">
						ERROR
					</Typography>
					<Typography align="center" style={{ whiteSpace: 'pre-wrap' }}>
						{error}
						{initialError}
					</Typography>
					<SupportLink />
				</div>
			)}
			{(!error && !initialError) && (<>

				<div className={classes.top}>
					{myPlayer && gameState.lobbyCode !== 'MENU' && (
						<>
							<div className={classes.avatarWrapper}>
								<Avatar
									deafened={deafenedState}
									muted={mutedState}
									player={myPlayer}
									borderColor={myPlayer?.shiftedColor == -1 ? '#2ecc71' : 'gray'}
									connectionState={connected ? 'connected' : 'disconnected'}
									isUsingRadio={myPlayer?.isImpostor && impostorRadioClientId.current === myPlayer.clientId}
									talking={talking}
									isAlive={!myPlayer.isDead}
									size={100}
									mod={gameState.mod}
								/>
							</div>
						</>
					)}
					<div className={classes.right}>
						<div>
							<div className={classes.left}>
								{myPlayer && gameState?.gameState !== GameState.MENU && (
									<span className={classes.username}>{myPlayer.name}</span>
								)}
								<span
									className={classes.code}
									style={{
										background: gameState.lobbyCode === 'MENU' ? 'transparent' : '#3e4346',
									}}
								>
									{displayedLobbyCode === 'MENU' ? t('game.menu') : displayedLobbyCode}
								</span>
							</div>
							{gameState.lobbyCode !== 'MENU' && (
								<div className={classes.muteButtons}>
									<IconButton onClick={connectionStuff.current.toggleMute} size="small">
										{mutedState || deafenedState ? <MicOff /> : <Mic />}
									</IconButton>
									<IconButton onClick={connectionStuff.current.toggleDeafen} size="small">
										{deafenedState ? <VolumeOff /> : <VolumeUp />}
									</IconButton>
								</div>
							)}
						</div>
					</div>
				</div>
				{lobbySettings.deadOnly && (
					<div className={classes.top}>
						<small style={{ padding: 0 }}>{t('settings.lobbysettings.ghost_only_warning2')}</small>
					</div>
				)}
				{lobbySettings.meetingGhostOnly && (
					<div className={classes.top}>
						<small style={{ padding: 0 }}>{t('settings.lobbysettings.meetings_only_warning2')}</small>
					</div>
				)}
				{gameState.lobbyCode && <Divider />}
				{displayedLobbyCode === 'MENU' && (
					<div className={classes.top}>
						<Button
							style={{ margin: '10px' }}
							onClick={() => {
								alert(t('buttons.public_lobby_unavailable'));
							}}
							color="primary"
							variant="outlined"
						>
							{t('buttons.public_lobby')}
						</Button>
					</div>
				)}
				{myPlayer && gameState.lobbyCode !== 'MENU' && (
					<Grid
						container
						spacing={1}
						className={classes.otherplayers}
						alignItems="flex-start"
						alignContent="flex-start"
						justifyContent="flex-start"
					>
						{otherPlayers.map((player) => {
							const peer = playerSocketIdsRef.current[player.clientId];
							const connected = socketClients[peer]?.clientId === player.clientId || false;
							const audio = audioConnected[peer];

							if (!playerConfigs[player.nameHash]) {
								playerConfigs[player.nameHash] = { volume: 1, isMuted: false };
							}
							const socketConfig = playerConfigs[player.nameHash];

							return (
								<Grid item key={player.id} xs={getPlayersPerRow(otherPlayers.length)}>
									<Avatar
										connectionState={!connected ? 'disconnected' : audio ? 'connected' : 'novoice'}
										player={player}
										talking={!player.inVent && otherTalking[player.clientId]}
										borderColor="#2ecc71"
										isAlive={!otherDead[player.clientId]}
										isUsingRadio={
											myPlayer?.isImpostor &&
											!(player.disconnected || player.bugged) &&
											impostorRadioClientId.current === player.clientId
										}
										size={50}
										socketConfig={socketConfig}
										onConfigChange={() => setSetting(`playerConfigMap.${player.nameHash}`, playerConfigs[player.nameHash])}
										mod={gameState.mod}
									/>
								</Grid>
							);
						})}
					</Grid>
				)}
			</>)}
			{otherPlayers.length <= 6 && <Footer />}
		</div>
	);
};

type ValidPlayersPerRow = 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;
function getPlayersPerRow(playerCount: number): ValidPlayersPerRow {
	if (playerCount <= 9) return (12 / 3) as ValidPlayersPerRow;
	else return Math.min(12, Math.floor(12 / Math.ceil(Math.sqrt(playerCount)))) as ValidPlayersPerRow;
}

export default Voice;
