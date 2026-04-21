import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';

export const BrainAnimation: React.FC = () => {
    return (
        <Box marginTop={1} paddingLeft={1}>
            <Text color="blue">
                <Spinner type="dots" />
            </Text>
            <Text italic color="cyan">  The Brain is pondering your request... </Text>
            <Text color="blue"> [ o ] </Text>
        </Box>
    );
};
