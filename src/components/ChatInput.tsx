import React, { useState } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';

interface ChatInputProps {
    isDisabled: boolean;
    onSendMessage: (text: string) => void;
}

export const ChatInput: React.FC<ChatInputProps> = ({ isDisabled, onSendMessage }) => {
    const [query, setQuery] = useState('');

    const handleSubmit = (value: string) => {
        if (!isDisabled && value.trim()) {
            onSendMessage(value);
            setQuery('');
        }
    };

    return (
        <Box>
            {isDisabled ? (
                <Text dimColor italic>The Brain is thinking... please wait, Pinky.</Text>
            ) : (
                <TextInput
                    value={query}
                    onChange={setQuery}
                    onSubmit={handleSubmit}
                    placeholder="Enter command for world domination..."
                />
            )}
        </Box>
    );
};
