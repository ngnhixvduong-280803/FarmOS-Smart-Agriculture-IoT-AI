import queryString from "query-string";

describe("React Navigation query-string compatibility", () => {
  it("exposes the named parse API through the Metro/Jest compatibility entrypoint", () => {
    expect(typeof queryString.parse).toBe("function");
    expect(queryString.parse("name=Farm%20OS")).toEqual({ name: "Farm OS" });
  });
});
