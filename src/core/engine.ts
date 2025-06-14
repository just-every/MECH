/**
 * Task Engine - Simplified Version
 *
 * Task implementation for LLM orchestration.
 * Provides meta-cognition and thought delays on top of ensemble.
 * Model rotation is handled by ensemble automatically.
 */

import { taskState } from '../state/state.js';
import { runThoughtDelay, getThoughtDelay } from './thought_utils.js';
import { spawnMetaThought } from './meta_cognition.js';
import { 
    ensembleRequest,
    createToolFunction,
    cloneAgent,
    waitWhilePaused,
    type ToolFunction,
    type Agent,
    type ResponseInput,
    type ProviderStreamEvent
} from '@just-every/ensemble';

// WeakMap to store message arrays for active tasks
const activeTaskMessages = new WeakMap<AsyncGenerator<ProviderStreamEvent>, ResponseInput>();

// Map to track cleanup functions for generators
const generatorCleanup = new WeakMap<AsyncGenerator<ProviderStreamEvent>, () => void>();

/**
 * Get Task control tools
 */
function getTaskTools(): ToolFunction[] {
    return [
        createToolFunction(
            (result: string ) => {
                console.log('[Task] Task completed:', result);
                // Return the result so it can be captured in the tool_done event
                return result;
            },
            'Report that the task has completed successfully',
            {
                result: {
                    type: 'string',
                    description: 'A few paragraphs describing the result. Be thorough and comprehensive.'
                }
            },
            undefined,
            'task_complete'
        ),
        
        createToolFunction(
            (error: string ) => {
                console.error('[Task] Task failed:', error);
                // Return the error so it can be captured in the tool_done event
                return error;
            },
            'Report that you were not able to complete the task',
            {
                error: {
                    type: 'string',
                    description: 'Describe the error that occurred in a few sentences'
                }
            },
            undefined,
            'task_fatal_error'
        )
    ];
}

/**
 * Run Mind with automatic everything
 * 
 * @param agent - The agent from ensemble
 * @param content - The task/prompt to execute
 * @returns AsyncGenerator that yields all ProviderStreamEvents
 * 
 * @example
 * ```typescript
 * import { Agent } from '@just-every/ensemble';
 * import { runTask } from '@just-every/task';
 * 
 * const agent = new Agent({ 
 *     name: 'MyAgent',
 *     modelClass: 'reasoning' 
 * });
 * 
 * for await (const event of runTask(agent, 'Analyze this code')) {
 *     console.log(event);
 * }
 * ```
 */
export function runTask(
    agent: Agent,
    content: string
): AsyncGenerator<ProviderStreamEvent> {
    // Basic validation
    if (!agent || typeof agent !== 'object') {
        throw new Error('Agent must be a valid Agent instance');
    }
    if (!content || typeof content !== 'string' || content.trim().length === 0) {
        throw new Error('Content must be a non-empty string');
    }
    
    // Build initial messages with tool guidance
    const toolGuidance = 'You must complete tasks by using the provided tools. When you have finished a task, you MUST call the task_complete tool with a comprehensive result. If you cannot complete the task, you MUST call the task_fatal_error tool with an explanation. Do not just provide a final answer without using these tools.';
    
    // Check if agent instructions already contain task_complete guidance
    if(!agent.instructions?.includes('task_complete')) {
        agent.instructions = agent.instructions ? `${agent.instructions}\n\n${toolGuidance}` : toolGuidance;
    }
    
    const messages: ResponseInput = [
        {
            type: 'message',
            role: 'user',
            content
        }
    ];

    // Create wrapper to handle cleanup
    async function* taskGenerator() {
        const startTime = Date.now();

        // Add Task tools to the agent
        const taskTools = getTaskTools();
        
        // Clone agent to get AgentDefinition and add Task tools
        const agentDef = cloneAgent(agent);
        agentDef.tools = [...taskTools, ...(agent.tools || [])];

        // Track completion state
        let isComplete = false;
        
        try {
            console.log(`[Task] Starting execution for agent: ${agent.name}`);
            
            // Run the request loop
            let iteration = 0;
            
            while (!isComplete && iteration < 100) {
                iteration++;
                
                // Wait if ensemble is paused (before any processing)
                await waitWhilePaused();
                
                // Apply thought delay (Mind-specific feature)
                if (iteration > 1) {
                    const delay = parseInt(getThoughtDelay());
                    if (delay > 0) {
                        await runThoughtDelay();
                    }
                }
                
                // Increment request counter for meta-cognition
                taskState.llmRequestCount++;
                
                // Check meta-cognition trigger (Mind-specific feature)
                const metaFrequency = parseInt(taskState.metaFrequency);
                if (taskState.llmRequestCount % metaFrequency === 0) {
                    console.log(`[Task] Triggering meta-cognition after ${taskState.llmRequestCount} requests`);
                    try {
                        await spawnMetaThought(agentDef, messages, new Date(startTime));
                    } catch (error) {
                        console.error('[Task] Error in meta-cognition:', error);
                    }
                }
                
                // Run ensemble request and yield all events
                for await (const event of ensembleRequest(messages, agentDef)) {
                    // Yield the event to the caller
                    yield event;
                    
                    // Handle tool calls
                    if (event.type === 'tool_done' && 'result' in event) {
                        const toolEvent = event as any;
                        const toolName = toolEvent.tool_call?.function?.name;
                        
                        if (toolName === 'task_complete') {
                            isComplete = true;
                            // Emit task_complete event
                            yield {
                                type: 'task_complete' as any,
                                result: toolEvent.result?.output || ''
                            };
                        } else if (toolName === 'task_fatal_error') {
                            isComplete = true;
                            // Emit task_fatal_error event
                            yield {
                                type: 'task_fatal_error' as any,
                                result: toolEvent.result?.output || ''
                            };
                        }
                    }
                    
                    // Add response to history
                    if (event.type === 'response_output') {
                        const responseEvent = event as any;
                        if (responseEvent.message) {
                            messages.push(responseEvent.message);
                        }
                    }
                }
            }

        } catch (error) {
            console.error('[Task] Error running agent:', error);
            
            // Yield an error event
            const errorMessage = error instanceof Error ? error.message : String(error);
            yield {
                type: 'error' as const,
                error: new Error(`Agent execution failed: ${errorMessage}`)
            } as ProviderStreamEvent;
        }
    }
    
    // Create the generator
    const generator = taskGenerator();

    // Store the messages array in the WeakMap
    activeTaskMessages.set(generator, messages);
    
    // Set up cleanup function
    const cleanup = () => {
        activeTaskMessages.delete(generator);
        generatorCleanup.delete(generator);
    };
    generatorCleanup.set(generator, cleanup);
    
    // Create a wrapper that ensures cleanup
    const wrappedGenerator = (async function* (): AsyncGenerator<ProviderStreamEvent> {
        try {
            for await (const event of generator) {
                yield event;
            }
        } finally {
            cleanup();
        }
    })();
    
    // Transfer the mapping to the wrapped generator
    activeTaskMessages.set(wrappedGenerator, messages);
    activeTaskMessages.delete(generator);
    generatorCleanup.set(wrappedGenerator, cleanup);
    generatorCleanup.delete(generator);
    
    return wrappedGenerator;
}

/**
 * Add a message to an active task's message stream
 * 
 * @param taskGenerator - The generator returned by runTask
 * @param message - The message to inject
 * 
 * @example
 * ```typescript
 * const task = runTask(agent, 'Analyze this code');
 * 
 * // Inject a message while task is running
 * addMessageToTask(task, {
 *     type: 'message',
 *     role: 'developer',
 *     content: 'Focus on performance issues'
 * });
 * ```
 */
export function addMessageToTask(
    taskGenerator: AsyncGenerator<ProviderStreamEvent>,
    message: ResponseInput[0]
): void {
    // Validate inputs
    if (!taskGenerator) {
        throw new Error('Task generator is required');
    }
    
    if (!message || typeof message !== 'object') {
        throw new Error('Message must be a valid message object');
    }
    if (!message.type || message.type !== 'message') {
        throw new Error('Message must have type "message"');
    }
    if (!message.role || !['system', 'user', 'assistant', 'developer'].includes(message.role)) {
        throw new Error('Message must have a valid role: system, user, assistant, or developer');
    }
    if (!message.content || typeof message.content !== 'string') {
        throw new Error('Message must have string content');
    }
    
    // Get the messages array for this task
    const messages = activeTaskMessages.get(taskGenerator);
    if (!messages) {
        throw new Error('Task not found or already completed. Messages can only be added to active tasks.');
    }
    
    // Add the message
    messages.push(message);
    console.log(`[Task] External message added with role: ${message.role}`);
}

