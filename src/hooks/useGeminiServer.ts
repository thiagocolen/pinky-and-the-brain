import { useState, useEffect, useCallback, useRef } from 'react';
import { spawn, ChildProcess } from 'child_process';
import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { log, logError } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Determine the path to the "the-brain" knowledge base.
// When packaged with 'pkg', assets are in the virtual filesystem at /snapshot/.
// In development, we use the PATBATPP_SRC_FOLDER or fallback to a local 'the-brain' folder.
const THE_BRAIN_PATH = (process as any).pkg
    ? path.resolve(__dirname, '..', 'the-brain')
    : (process.env.PATBATPP_SRC_FOLDER || path.resolve(process.cwd(), 'the-brain'));

export interface Message {
    role: 'user' | 'agent' | 'system' | 'thought';
    text: string;
}

export interface GeminiState {
    status: 'idle' | 'initializing' | 'ready' | 'processing' | 'error';
    messages: Message[];
    error: string | null;
}

export const useGeminiServer = () => {
    const [state, setState] = useState<GeminiState>({
        status: 'idle',
        messages: [],
        error: null,
    });

    const geminiRef = useRef<ChildProcess | null>(null);
    const requestIdRef = useRef(1);
    const sessionIdRef = useRef<string | null>(null);

    const appendMessage = useCallback((message: Message) => {
        setState(prev => ({
            ...prev,
            messages: [...prev.messages, message]
        }));
    }, []);

    const updateLastMessageChunk = useCallback((text: string, role: Message['role']) => {
        setState(prev => {
            const newMessages = [...prev.messages];
            const lastIndex = newMessages.length - 1;
            const lastMessage = newMessages[lastIndex];
            
            if (lastMessage && lastMessage.role === role) {
                newMessages[lastIndex] = {
                    ...lastMessage,
                    text: lastMessage.text + text
                };
                return { ...prev, messages: newMessages };
            } else {
                return { ...prev, messages: [...newMessages, { role, text }] };
            }
        });
    }, []);

    const send = useCallback((method: string, params: any) => {
        if (geminiRef.current && !geminiRef.current.killed && geminiRef.current.stdin?.writable) {
            const msg = {
                jsonrpc: '2.0',
                id: requestIdRef.current++,
                method,
                params
            };
            log(`--> Sending Request [${method}]`, msg);
            try {
                geminiRef.current.stdin.write(JSON.stringify(msg) + '\n');
            } catch (err) {
                log('Error writing to gemini stdin:');
                logError(err);
            }
        } else {
            log(`Cannot send [${method}]: process is not ready or stdin is not writable`);
        }
    }, []);

    const sendResponse = useCallback((id: number, result: any) => {
        if (geminiRef.current && !geminiRef.current.killed && geminiRef.current.stdin?.writable) {
            const msg = {
                jsonrpc: '2.0',
                id,
                result
            };
            log(`--> Sending Response [${id}]`, msg);
            try {
                geminiRef.current.stdin.write(JSON.stringify(msg) + '\n');
            } catch (err) {
                logError(err);
            }
        }
    }, []);

    const sendError = useCallback((id: number, code: number, message: string) => {
        if (geminiRef.current && !geminiRef.current.killed && geminiRef.current.stdin?.writable) {
            const msg = {
                jsonrpc: '2.0',
                id,
                error: { code, message }
            };
            log(`--> Sending Error [${id}]`, msg);
            try {
                geminiRef.current.stdin.write(JSON.stringify(msg) + '\n');
            } catch (err) {
                logError(err);
            }
        }
    }, []);

    const handleServerRequest = useCallback(async (id: number, method: string, params: any) => {
        log(`Handling server request [${method}] id=${id}`, params);
        try {
            switch (method) {
                case 'fs/readTextFile':
                case 'fs/read_text_file': {
                    const fullPath = path.resolve(process.cwd(), params.path);
                    if (!fs.existsSync(fullPath)) {
                        sendError(id, -32602, `File not found: ${params.path}`);
                        return;
                    }
                    const content = fs.readFileSync(fullPath, 'utf8');
                    sendResponse(id, { content, outcome: { kind: 'success' } });
                    break;
                }
                case 'fs/writeTextFile':
                case 'fs/write_text_file': {
                    const fullPath = path.resolve(process.cwd(), params.path);
                    const dir = path.dirname(fullPath);
                    if (!fs.existsSync(dir)) {
                        fs.mkdirSync(dir, { recursive: true });
                    }
                    fs.writeFileSync(fullPath, params.content, 'utf8');
                    sendResponse(id, { success: true, outcome: { kind: 'success' } });
                    break;
                }
                case 'terminal/write': {
                    appendMessage({ role: 'system', text: params.content });
                    sendResponse(id, { success: true, outcome: { kind: 'success' } });
                    break;
                }
                case 'terminal/readLine': {
                    log('terminal/readLine requested but not fully implemented. Returning empty string.');
                    sendResponse(id, { content: '', outcome: { kind: 'success' } });
                    break;
                }
                case 'session/request_permission': {
                    const allowOption = params.options.find((o: any) => o.kind === 'allow_once' || o.kind === 'allow_always');
                    if (allowOption) {
                        log(`Auto-allowing permission request: ${params.toolCall?.title || method}`);
                        sendResponse(id, { 
                            outcome: {
                                outcome: 'selected',
                                optionId: allowOption.optionId
                            }
                        });
                    } else {
                        log('No allow option found in request_permission');
                        sendError(id, -32603, "No allow option found");
                    }
                    break;
                }
                default:
                    log(`Unhandled server request method: ${method}`);
                    sendError(id, -32601, `Method not found: ${method}`);
            }
        } catch (err) {
            logError(err);
            sendError(id, -32603, err instanceof Error ? err.message : String(err));
        }
    }, [appendMessage, sendResponse, sendError]);

    const sendMessage = useCallback((text: string) => {
        const command = text.trim().toLowerCase();
        if (command === 'exit' || command === 'quit') {
            log('Exit command received. Closing application...');
            process.exit(0);
        }

        if (state.status !== 'ready' || !sessionIdRef.current) {
            log(`Cannot sendMessage: status is ${state.status}, sessionId is ${sessionIdRef.current}`);
            return;
        }

        appendMessage({ role: 'user', text });
        setState(prev => ({ ...prev, status: 'processing' }));

        send('session/prompt', {
            sessionId: sessionIdRef.current,
            prompt: [{ type: 'text', text }]
        });
    }, [state.status, appendMessage, send]);

    useEffect(() => {
        log('Initializing Gemini server hook...');
        setState(prev => ({ ...prev, status: 'initializing' }));

        log('Spawning gemini --acp...');
        const gemini = spawn('gemini', ['--acp'], {
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: true
        });
        geminiRef.current = gemini;

        gemini.stderr?.on('data', (data) => {
            const str = data.toString();
            log(`Gemini STDERR: ${str}`);
        });

        gemini.on('error', (err) => {
            log('Process spawn error event!');
            logError(err);
            setState(prev => ({ ...prev, status: 'error', error: `Failed to spawn Gemini process: ${err.message}` }));
        });

        const geminiOut = readline.createInterface({
            input: gemini.stdout!
        });

        // 1. Initialize Handshake
        log('Sending initialize request...');
        send('initialize', {
            protocolVersion: 1,
            clientCapabilities: {
                auth: { terminal: true },
                fs: { 
                    readTextFile: true, 
                    writeTextFile: true,
                    read_text_file: true,
                    write_text_file: true
                },
                terminal: true,
                toolConfirmation: true,
                session: { request_permission: true }
            },
            clientInfo: { name: 'gemini-secure-wrapper', version: '1.4.0' }
        });

        geminiOut.on('line', (line) => {
            try {
                const response = JSON.parse(line);
                log('<-- Received:', response);

                const { id, method, params, result, error } = response;

                // 1. Handle Responses to our requests (has id AND (result OR error) AND NO method)
                if (id !== undefined && (result !== undefined || error !== undefined) && method === undefined) {
                    if (id === 1) { // Response to 'initialize'
                        if (error) {
                            setState(prev => ({ ...prev, status: 'error', error: `Initialization failed: ${JSON.stringify(error)}` }));
                            return;
                        }
                        send('session/new', {
                            cwd: process.cwd(),
                            mcpServers: [],
                            systemInstruction: `You are 'The Brain', from the Pinky and the Brain show. 
                            You have a specialized knowledge base located at: ${THE_BRAIN_PATH}
                            When the user asks about 'the brain', your skills, agents, commands, tools, or prompts, 
                            you MUST use your filesystem tools to explore that directory and its subfolders 
                            to provide a detailed and accurate response about your capabilities.`
                        });
                    } else if (id === 2) { // Response to 'session/new'
                        if (error) {
                            setState(prev => ({ ...prev, status: 'error', error: `Session creation failed: ${JSON.stringify(error)}` }));
                            return;
                        }
                        sessionIdRef.current = result.sessionId;
                        setState(prev => ({ ...prev, status: 'ready' }));
                    } else {
                        // Response to session/prompt or other client-initiated request
                        setState(prev => {
                            if (prev.status === 'processing') {
                                return { 
                                    ...prev, 
                                    status: 'ready', 
                                    error: error ? (error.message || JSON.stringify(error)) : prev.error 
                                };
                            }
                            return prev;
                        });
                    }
                } 
                // 2. Handle Server Requests (has id AND method)
                else if (id !== undefined && method !== undefined) {
                    handleServerRequest(id, method, params);
                }
                // 3. Handle Notifications (NO id, but has method)
                else if (id === undefined && method !== undefined) {
                    if (method === 'session/update') {
                        const update = params.update;
                        if (update.sessionUpdate === 'agent_message_chunk') {
                            if (update.content && update.content.text) {
                                updateLastMessageChunk(update.content.text, 'agent');
                            }
                        } else if (update.sessionUpdate === 'agent_thought_chunk') {
                            if (update.content && update.content.text) {
                                updateLastMessageChunk(update.content.text, 'thought');
                            }
                        }
                    } else if (method === 'terminal/write') {
                        appendMessage({ role: 'system', text: params.content });
                    } else {
                        log(`Unhandled notification: ${method}`);
                    }
                }
                else {
                    log('Unknown message format received from server', response);
                }
            } catch (e) {
                // Ignore non-JSON output
                log('Non-JSON output from gemini stdout:', line);
            }
        });

        gemini.on('close', (code) => {
            log(`Gemini process closed with code ${code}`);
            if (code !== 0 && code !== null) {
                setState(prev => ({ ...prev, status: 'error', error: `Gemini process exited with code ${code}` }));
            }
        });

        return () => {
            log('Cleaning up Gemini server hook...');
            gemini.kill();
        };
    }, [send, updateLastMessageChunk, handleServerRequest, appendMessage]);

    return { ...state, sendMessage };
};
