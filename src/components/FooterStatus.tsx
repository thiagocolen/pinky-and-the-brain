import React from 'react';
import { Box, Text } from 'ink';

interface FooterStatusProps {
    workspace: string;
    branch: string;
    sandbox: string;
    model: string;
}

export const FooterStatus: React.FC<FooterStatusProps> = ({ workspace, branch, sandbox, model }) => {
    return (
        <Box flexDirection="column" paddingX={1}>
            <Box justifyContent="space-between">
                <Box flexBasis="40%">
                    <Text dimColor>workspace (/directory)</Text>
                </Box>
                <Box flexBasis="30%">
                    <Text dimColor>branch</Text>
                </Box>
                <Box flexBasis="30%">
                    <Text dimColor>sandbox</Text>
                </Box>
            </Box>
            <Box justifyContent="flex-end">
                <Text dimColor>/model</Text>
            </Box>
            <Box justifyContent="space-between">
                <Box flexBasis="40%">
                    <Text bold color="white">{workspace}</Text>
                </Box>
                <Box flexBasis="30%">
                    <Text bold color="blue">{branch}</Text>
                </Box>
                <Box flexBasis="30%" flexDirection="row" justifyContent="space-between">
                    <Box>
                        <Text bold color="yellow">{sandbox}</Text>
                    </Box>
                    <Box>
                        <Text bold color="green">{model}</Text>
                    </Box>
                </Box>
            </Box>
        </Box>
    );
};
