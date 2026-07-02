/**
 * LobbyBrowser — Public Lobby feature placeholder for StarLink.
 * Socket.io-based public lobby browsing is not compatible with the
 * Interstellar WebSocket protocol. This component renders a "coming soon"
 * message while preserving the full file as a stub so the feature can be
 * implemented in the future.
 */
import React from 'react';
import makeStyles from '@mui/styles/makeStyles';
import Typography from '@mui/material/Typography';
import { useTranslation } from 'react-i18next';

const useStyles = makeStyles({
	root: {
		width: '100%',
		height: '100%',
		display: 'flex',
		flexDirection: 'column',
		alignItems: 'center',
		justifyContent: 'center',
		padding: 24,
		boxSizing: 'border-box',
		backgroundColor: '#1d1a23',
		color: '#fff',
	},
	title: {
		fontSize: '1.4rem',
		fontWeight: 'bold',
		marginBottom: 12,
	},
	subtitle: {
		fontSize: '0.95rem',
		color: '#aaa',
		textAlign: 'center',
		maxWidth: 360,
	},
});

const LobbyBrowser: React.FC = () => {
	const classes = useStyles();
	const { t } = useTranslation();

	return (
		<div className={classes.root}>
			<Typography className={classes.title}>
				{t('buttons.public_lobby')}
			</Typography>
			<Typography className={classes.subtitle}>
				{t('buttons.public_lobby_unavailable')}
			</Typography>
		</div>
	);
};

export default LobbyBrowser;
