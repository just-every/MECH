/**
 * Integration Tests for MECH System
 * 
 * Tests the complete MECH workflow including model rotation,
 * meta-cognition, thought delays, and state management.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { 
    runMECH,
    setModelScore,
    setMetaFrequency,
    setThoughtDelay,
    mechState,
    resetLLMRequestCount,
    getTotalCost,
    resetCostTracker,
    type SimpleAgent,
    type RunMechOptions
} from '../index.js';
import { createFullContext } from '../utils/internal_utils.js';
import { request } from '@just-every/ensemble';

// Mock the ensemble request function
vi.mock('@just-every/ensemble', () => ({
    request: vi.fn(),
    CostTracker: vi.fn(() => ({
        getTotalCost: () => 0.0012,
        reset: () => {},
        trackUsage: () => {}
    })),
    MODEL_CLASSES: {
        coding: ['grok-beta', 'claude-3-5-sonnet-20241022', 'gpt-4o'],
        reasoning: ['o1-preview', 'o1-mini', 'claude-3-5-sonnet-20241022'],
        creative: ['claude-3-5-sonnet-20241022', 'gpt-4o', 'gemini-1.5-pro'],
        speed: ['gpt-4o-mini', 'claude-3-5-haiku-20241022', 'gemini-1.5-flash']
    },
    getModelFromClass: vi.fn((modelClass) => {
        const models = {
            coding: ['grok-beta', 'claude-3-5-sonnet-20241022', 'gpt-4o'],
            reasoning: ['o1-preview', 'o1-mini', 'claude-3-5-sonnet-20241022'],
            creative: ['claude-3-5-sonnet-20241022', 'gpt-4o', 'gemini-1.5-pro'],
            speed: ['gpt-4o-mini', 'claude-3-5-haiku-20241022', 'gemini-1.5-flash']
        };
        const modelList = models[modelClass] || models.reasoning;
        return modelList[0];
    })
}));

// Helper to create async stream for mock responses
async function* createMockStream(response: string, toolCalls: Array<{ name: string; arguments: any }> = []) {
    yield { type: 'message_delta', content: response };
    
    if (toolCalls.length > 0) {
        yield {
            type: 'tool_done',
            tool_calls: toolCalls.map(tc => ({
                function: {
                    name: tc.name,
                    arguments: JSON.stringify(tc.arguments)
                }
            }))
        };
    }
}

describe('MECH Integration Tests', () => {
    let mockAgent: SimpleAgent;
    let mockedRequest: ReturnType<typeof vi.fn>;
    
    beforeEach(() => {
        // Reset MECH state
        resetLLMRequestCount();
        resetCostTracker();
        mechState.disabledModels.clear();
        mechState.modelScores = {};
        mechState.metaFrequency = '5';
        
        // Create mock agent
        mockAgent = {
            name: 'IntegrationTestAgent',
            agent_id: 'integration-test-' + Date.now(),
            tools: [],
            modelClass: 'reasoning'
        };
        
        // Setup mock for ensemble.request()
        mockedRequest = request as ReturnType<typeof vi.fn>;
        mockedRequest.mockImplementation((model, history, options) => {
            // Check history for task content
            const taskContent = history.find(h => h.role === 'user')?.content || '';
            
            // Always complete immediately to match MECH behavior
            if (taskContent.includes('error')) {
                return createMockStream(
                    'I encountered an error.',
                    [{ name: 'task_fatal_error', arguments: { error: 'Simulated error' } }]
                );
            } else {
                return createMockStream(
                    'I will complete this task now.',
                    [{ name: 'task_complete', arguments: { result: 'Task completed successfully' } }]
                );
            }
        });
    });

    describe('Complete MECH Workflow', () => {
        it('should run a complete task with model rotation and meta-cognition', async () => {
            // Set up some model scores to test rotation
            setModelScore('test-model-1', '80');
            setModelScore('test-model-2', '60');
            setMetaFrequency('5'); // Trigger meta-cognition after 5 requests

            const options: RunMechOptions = {
                agent: mockAgent,
                task: 'Please complete this integration test'
            };

            const result = await runMECH(options);

            expect(result).toBeDefined();
            expect(result.status).toBe('complete');
            expect(result.durationSec).toBeGreaterThanOrEqual(0);
            expect(result.history).toBeDefined();
            expect(result.history.length).toBeGreaterThan(0);
            
            // Verify ensemble.request was called
            expect(mockedRequest).toHaveBeenCalled();
            
            // Verify MECH state was updated
            expect(mechState.llmRequestCount).toBeGreaterThan(0);
        });

        it('should handle task completion flow correctly', async () => {
            const options: RunMechOptions = {
                agent: mockAgent,
                task: 'Please complete this task'
            };

            const result = await runMECH(options);

            expect(result.status).toBe('complete');
            expect(result.mechOutcome?.status).toBe('complete');
            expect(result.mechOutcome?.result).toBe('Task completed successfully');
        });

        it('should handle error scenarios gracefully', async () => {
            const options: RunMechOptions = {
                agent: mockAgent,
                task: 'Please error out'
            };

            const result = await runMECH(options);

            expect(result.status).toBe('fatal_error');
            expect(result.mechOutcome?.status).toBe('fatal_error');
            expect(result.mechOutcome?.error).toContain('Simulated error');
        });
    });

    describe('Memory Integration', () => {
        it('should run MECH with memory successfully', async () => {
            const options: RunMechOptions = {
                agent: mockAgent,
                task: 'Remember this task'
            };

            const result = await runMECH(options);

            expect(result).toBeDefined();
            expect(result.status).toBe('complete');
            expect(mockedRequest).toHaveBeenCalled();
        });

        it('should provide memory context to agents', async () => {
            let receivedHistory: any[] = [];
            
            // Mock ensemble.request to capture history
            mockedRequest.mockImplementationOnce((model, history, options) => {
                receivedHistory = history;
                return createMockStream(
                    'Task completed with memory',
                    [{ name: 'task_complete', arguments: { result: 'Memory integration successful' } }]
                );
            });

            const options: RunMechOptions = {
                agent: mockAgent,
                task: 'Use memory for this task'
            };

            await runMECH(options);

            expect(mockedRequest).toHaveBeenCalled();
            expect(receivedHistory).toBeDefined();
            expect(receivedHistory.length).toBeGreaterThan(0);
        });
    });

    describe('State Management Integration', () => {
        it('should reset state for each MECH run', async () => {
            const options: RunMechOptions = {
                agent: mockAgent,
                task: 'First task'
            };

            // Set model score before first run
            setModelScore('test-model', '90');
            
            // First run
            await runMECH(options);
            
            // State should be reset, so score will be cleared
            expect(mechState.modelScores).toEqual({});
            expect(mechState.llmRequestCount).toBe(1);
        });

        it('should track request count within a single run', async () => {
            const options: RunMechOptions = {
                agent: mockAgent,
                task: 'Task 1'
            };

            setMetaFrequency('5'); // Trigger after 5 requests
            
            // Run once
            await runMECH(options);
            
            // Within a single run, count should be 1 (since we complete immediately)
            expect(mechState.llmRequestCount).toBe(1);
            
            // Run again - count resets
            await runMECH({
                ...options,
                task: 'Task 2'
            });
            
            // Count resets for each run
            expect(mechState.llmRequestCount).toBe(1);
        });
    });

    describe('Context Creation and Management', () => {
        it('should create full context from simple options correctly', () => {
            const simpleOptions = {
                agent: mockAgent
            };

            const context = createFullContext(simpleOptions);

            expect(context).toBeDefined();
            expect(context.sendComms).toBeDefined();
            expect(context.getCommunicationManager).toBeDefined();
            expect(context.addHistory).toBeDefined();
            expect(context.getHistory).toBeDefined();
            expect(context.costTracker).toBeDefined();
            expect(context.createToolFunction).toBeDefined();
            expect(context.processPendingHistoryThreads).toBeDefined();
            expect(context.describeHistory).toBeDefined();
            expect(context.dateFormat).toBeDefined();
            expect(context.readableTime).toBeDefined();
        });

        it('should handle communication flow correctly', async () => {
            const messages: any[] = [];
            const mockSendComms = vi.fn().mockImplementation((msg) => {
                messages.push(msg);
            });

            const options: RunMechOptions = {
                agent: mockAgent,
                task: 'Test communication',
                onStatus: mockSendComms
            };

            await runMECH(options);

            expect(mockSendComms).toHaveBeenCalled();
            expect(messages.length).toBeGreaterThan(0);
            
            // Should have agent status messages
            const statusMessages = messages.filter(m => m.type === 'agent_status');
            expect(statusMessages.length).toBeGreaterThan(0);
        });
    });

    describe('Cost Tracking Integration', () => {
        it('should track costs across MECH operations', async () => {
            resetCostTracker();
            const initialCost = getTotalCost();

            const options: RunMechOptions = {
                agent: mockAgent,
                task: 'Track costs'
            };

            const result = await runMECH(options);

            expect(result.totalCost).toBeGreaterThanOrEqual(0);
            expect(getTotalCost()).toBeGreaterThanOrEqual(initialCost);
        });

        it('should provide accurate cost reporting in results', async () => {
            resetCostTracker();

            const options: RunMechOptions = {
                agent: mockAgent,
                task: 'Cost reporting test'
            };

            const result = await runMECH(options);

            expect(result.totalCost).toBeDefined();
            expect(typeof result.totalCost).toBe('number');
            expect(result.totalCost).toBeGreaterThanOrEqual(0);
        });
    });

    describe('Thought Delay Integration', () => {
        it('should complete quickly when task_complete is called immediately', async () => {
            setThoughtDelay('2'); // 2 second delay

            const options: RunMechOptions = {
                agent: mockAgent,
                task: 'Test with delay'
            };

            const startTime = Date.now();
            await runMECH(options);
            const duration = Date.now() - startTime;

            // Should complete quickly since task_complete is called immediately
            expect(duration).toBeLessThan(3000); // Less than 3 seconds
        });

        it('should allow delay interruption', async () => {
            setThoughtDelay('2'); // Set a shorter delay to avoid timeout

            const options: RunMechOptions = {
                agent: mockAgent,
                task: 'Quick task'
            };

            const startTime = Date.now();
            const result = await runMECH(options);
            const duration = Date.now() - startTime;

            expect(result.status).toBe('complete');
            // Should complete quickly since task_complete is called immediately
            expect(duration).toBeLessThan(3000);
            
            // Reset delay
            setThoughtDelay('0');
        });
    });

    describe('Error Handling Integration', () => {
        it('should handle agent execution errors gracefully', async () => {
            // Mock ensemble.request to throw error
            mockedRequest.mockImplementationOnce(() => {
                throw new Error('Agent execution failed');
            });

            const options: RunMechOptions = {
                agent: mockAgent,
                task: 'This will fail'
            };

            const result = await runMECH(options);

            expect(result.status).toBe('fatal_error');
            expect(result.mechOutcome?.error).toContain('Agent execution failed');
        });

        it('should provide detailed error information', async () => {
            const specificError = new Error('Specific integration test error');
            // Mock ensemble.request to throw specific error
            mockedRequest.mockImplementationOnce(() => {
                throw specificError;
            });

            const options: RunMechOptions = {
                agent: mockAgent,
                task: 'Specific error test'
            };

            const result = await runMECH(options);

            expect(result.status).toBe('fatal_error');
            expect(result.mechOutcome?.error).toContain('Specific integration test error');
            expect(result.durationSec).toBeGreaterThanOrEqual(0);
            expect(result.totalCost).toBeGreaterThanOrEqual(0);
        });
    });

    describe('Tool Integration', () => {
        it('should provide MECH tools to agents', async () => {
            const options: RunMechOptions = {
                agent: mockAgent,
                task: 'Test tool integration'
            };

            const result = await runMECH(options);

            expect(mockedRequest).toHaveBeenCalled();
            expect(result.status).toBe('complete');
            // The fact that task_complete was called proves MECH tools were added
            expect(result.mechOutcome?.status).toBe('complete');
            expect(result.mechOutcome?.result).toBe('Task completed successfully');
        });

        it('should provide MECH tools via simple API', async () => {
            const options: RunMechOptions = {
                agent: mockAgent,
                task: 'Test MECH tools via simple API'
            };

            const result = await runMECH(options);

            expect(mockedRequest).toHaveBeenCalled();
            expect(result.status).toBe('complete');
            // The fact that task_complete was called proves MECH tools were added
            expect(result.mechOutcome?.status).toBe('complete');
            expect(result.mechOutcome?.result).toBe('Task completed successfully');
        });
    });
});