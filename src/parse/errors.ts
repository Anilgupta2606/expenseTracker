export class PasswordNeededError extends Error {
  constructor(public incorrect: boolean) {
    super(incorrect ? 'Incorrect password' : 'Password required');
  }
}
