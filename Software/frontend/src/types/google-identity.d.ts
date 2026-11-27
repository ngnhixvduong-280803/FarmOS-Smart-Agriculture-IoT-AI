interface GoogleCredentialResponse {
  credential: string;
  select_by: string;
}

interface GoogleIdConfiguration {
  client_id: string;
  callback: (response: GoogleCredentialResponse) => void | Promise<void>;
  nonce?: string;
  context?: "signin" | "signup" | "use";
  cancel_on_tap_outside?: boolean;
  itp_support?: boolean;
  auto_select?: boolean;
  use_fedcm_for_prompt?: boolean;
  use_fedcm_for_button?: boolean;
}

interface GoogleButtonConfiguration {
  type?: "standard" | "icon";
  theme?: "outline" | "filled_blue" | "filled_black";
  size?: "small" | "medium" | "large";
  text?: "signin_with" | "signup_with" | "continue_with" | "signin";
  shape?: "rectangular" | "pill" | "circle" | "square";
  logo_alignment?: "left" | "center";
  width?: number;
}

interface Window {
  google?: {
    accounts: {
      id: {
        initialize: (configuration: GoogleIdConfiguration) => void;
        prompt: () => void;
        renderButton: (parent: HTMLElement, options: GoogleButtonConfiguration) => void;
        cancel: () => void;
      };
    };
  };
}
