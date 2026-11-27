const React = require('react');
const { View } = require('react-native');
const Map = ({ children, ...props }) => React.createElement(View, props, children);
const Camera = React.forwardRef(({ children, ...props }, ref) => {
  React.useImperativeHandle(ref, () => ({ easeTo: jest.fn(), flyTo: jest.fn(), jumpTo: jest.fn() }));
  return React.createElement(View, props, children);
});
const Marker = ({ children, ...props }) => React.createElement(View, props, children);
module.exports = { Map, Camera, Marker };
