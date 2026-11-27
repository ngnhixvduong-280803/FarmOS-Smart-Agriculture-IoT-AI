import React from "react";
import ReactTestRenderer from "react-test-renderer";

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock"),
);
jest.mock("@swan-io/react-native-browser", () => ({
  openBrowser: jest.fn().mockResolvedValue(undefined),
  closeBrowser: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../src/services/supabase", () => {
  const original = jest.requireActual("../src/services/supabase");
  return {
    ...original,
    beginGoogleSignIn: jest.fn().mockResolvedValue(undefined),
    signInWithEmail: jest.fn().mockResolvedValue("mock-access-token"),
    signUpWithEmail: jest.fn().mockResolvedValue({
      accessToken: "mock-signup-token",
      needsEmailConfirmation: false,
    }),
  };
});

import { Icon, type IconName } from "../src/components/Icon";
import { UserAvatar } from "../src/components/UserAvatar";
import { AuthScreen } from "../src/screens/AuthScreen";

describe("Native Auth & UI Components", () => {
  describe("Icon component", () => {
    it("renders native platform symbols with the requested size and tint", () => {
      const testNames: IconName[] = ["home", "cpu", "bell", "shield", "sprout", "droplet"];
      for (const name of testNames) {
        let renderer: ReactTestRenderer.ReactTestRenderer | null = null;
        ReactTestRenderer.act(() => {
          renderer = ReactTestRenderer.create(<Icon name={name} size={24} color="#16704a" />);
        });
        expect(renderer).not.toBeNull();
        const tree = renderer!.toJSON() as ReactTestRenderer.ReactTestRendererJSON;
        expect(tree.type).toBe("RNSfsymbols");
        expect(tree.props.systemName).toBeTruthy();
        expect(tree.props.iconColor).toBeTruthy();
        expect(tree.props.style).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              width: 24,
              height: 24,
            }),
          ]),
        );
      }
    });
  });

  describe("AuthScreen component", () => {
    it("renders Google-only authentication", async () => {
      let renderer: ReactTestRenderer.ReactTestRenderer | null = null;

      await ReactTestRenderer.act(async () => {
        renderer = ReactTestRenderer.create(<AuthScreen />);
      });

      expect(renderer).not.toBeNull();
      const instance = renderer!.root;

      // Email/password credentials and registration are intentionally absent.
      const textInputs = instance.findAllByType("TextInput" as any);
      expect(textInputs.length).toBe(0);

      const googleBtn = instance.findByProps({ accessibilityLabel: "Tiếp tục với Google" });
      expect(googleBtn).toBeTruthy();
    });
  });

  describe("UserAvatar", () => {
    it("uses the supplied Google profile photo instead of initials", () => {
      let renderer: ReactTestRenderer.ReactTestRenderer | null = null;
      ReactTestRenderer.act(() => {
        renderer = ReactTestRenderer.create(<UserAvatar avatarUrl="https://lh3.googleusercontent.com/avatar" backgroundColor="#ffffff" borderColor="#bbf7d0" email="duy@example.com" name="Duy Lê Văn" size={40} textColor="#16704a" />);
      });

      expect(renderer!.root.findAll((node) => node.props.source?.uri === "https://lh3.googleusercontent.com/avatar").length).toBeGreaterThan(0);
    });

    it("keeps initials as the fallback when no profile photo is available", () => {
      let renderer: ReactTestRenderer.ReactTestRenderer | null = null;
      ReactTestRenderer.act(() => {
        renderer = ReactTestRenderer.create(<UserAvatar backgroundColor="#ffffff" borderColor="#bbf7d0" email="duy@example.com" name="Duy Lê Văn" size={40} textColor="#16704a" />);
      });

      expect(renderer!.root.findByProps({ children: "DV" })).toBeTruthy();
    });
  });
});
