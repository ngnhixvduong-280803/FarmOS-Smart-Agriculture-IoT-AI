module.exports = {
  getCurrentPosition: (_success, error) => error?.({ code: 1, message: 'Location unavailable in Jest' }),
  requestAuthorization: () => Promise.resolve('denied'),
};
