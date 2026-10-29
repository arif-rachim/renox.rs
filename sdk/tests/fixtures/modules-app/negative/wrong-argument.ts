// A service called with the wrong argument type fails tsc.
import { auth } from "renox:modules";

export const x = auth.getUser(42);
