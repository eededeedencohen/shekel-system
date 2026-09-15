/**
 * @file catchAsync — async-route error wrapper
 * @module utils/catchAsync
 *
 * Express does not pipe rejected promises to next() automatically. Wrapping
 * each async controller in `catchAsync` removes the per-handler try/catch
 * boilerplate and routes any thrown error to the global error middleware.
 *
 * @example
 *   const getUsers = catchAsync(async (req, res) => {
 *     const users = await User.find();
 *     res.status(200).json({ status: "success", data: { users } });
 *   });
 */

module.exports = (fn) => (req, res, next) => {
  fn(req, res, next).catch(next);
};
