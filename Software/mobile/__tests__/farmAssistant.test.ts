jest.mock('../src/services/api', () => ({ request: jest.fn() }));
import { request } from '../src/services/api';
import { farmAssistant } from '../src/services/farmAssistant';
const mockRequest = request as jest.Mock;
beforeEach(() => mockRequest.mockReset());
test('scopes report and journal requests to the selected encoded farm', () => {
  farmAssistant.report('farm / A'); farmAssistant.journal('farm / A');
  expect(mockRequest).toHaveBeenNthCalledWith(1, '/farm-assistant/farm%20%2F%20A');
  expect(mockRequest).toHaveBeenNthCalledWith(2, '/farm-journal/farm%20%2F%20A');
});
test('sends journal requests to the selected farm with intended content', () => {
  farmAssistant.addJournal('farm-A', { category: 'pest', title: 'Lá vàng', notes: 'Ghi nhận' });
  expect(mockRequest).toHaveBeenNthCalledWith(1, '/farm-journal/farm-A', { method: 'POST', body: JSON.stringify({ category: 'pest', title: 'Lá vàng', notes: 'Ghi nhận' }) });
});

test('requests simulation analysis only for the selected encoded farm', () => {
  const { getSimulationAnalysis } = require('../src/services/farmAssistant');
  getSimulationAnalysis('SIM_garden / 1');
  expect(mockRequest).toHaveBeenCalledWith('/simulation/farm-analysis?farmId=SIM_garden%20%2F%201');
});
