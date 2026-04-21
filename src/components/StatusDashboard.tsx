import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';

interface StatusDashboardProps {
    status: string;
    error: string | null;
    version?: string;
}

export const StatusDashboard: React.FC<StatusDashboardProps> = ({ status, error, version }) => {
    let statusColor = 'yellow';
    let statusText = status.toUpperCase();

    if (status === 'ready') {
        statusColor = 'green';
        statusText = 'READY FOR WORLD DOMINATION';
    } else if (status === 'error') {
        statusColor = 'red';
        statusText = 'SYSTEM FAILURE (HURT PINKY)';
    } else if (status === 'processing') {
        statusColor = 'blue';
        statusText = 'CALCULATING GENIUS...';
    }

    return (
        <Box width="100%" justifyContent="space-between">
            <Box>
                <Text bold color="magenta">[ THE BRAIN ] </Text>
                <Text color={statusColor}>{statusText}</Text>
            </Box>
            {error && (
                <Box marginLeft={2}>
                    <Text color="red" wrap="truncate-end">ERR: {error}</Text>
                </Box>
            )}
            <Box>
                <Text dimColor>Plan: Take Over The World {version && `(v${version})`}</Text>
            </Box>
        </Box>
    );
};
