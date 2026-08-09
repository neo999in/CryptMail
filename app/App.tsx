import { DarkTheme, NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useFonts } from 'expo-font';
import { JetBrainsMono_400Regular, JetBrainsMono_500Medium } from '@expo-google-fonts/jetbrains-mono';
import {
  Manrope_400Regular,
  Manrope_500Medium,
  Manrope_600SemiBold,
  Manrope_700Bold,
  Manrope_800ExtraBold,
} from '@expo-google-fonts/manrope';
import { SpaceGrotesk_500Medium, SpaceGrotesk_700Bold } from '@expo-google-fonts/space-grotesk';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Platform, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { RootStackParamList } from './src/navigation';
import { ComposeScreen } from './src/screens/ComposeScreen';
import { ConnectScreen } from './src/screens/ConnectScreen';
import { ConversationScreen } from './src/screens/ConversationScreen';
import { DraftsScreen } from './src/screens/DraftsScreen';
import { InboxScreen } from './src/screens/InboxScreen';
import { KeysScreen } from './src/screens/KeysScreen';
import { MessageScreen } from './src/screens/MessageScreen';
import { RecoveryScreen } from './src/screens/RecoveryScreen';
import { ScheduledScreen } from './src/screens/ScheduledScreen';
import { SetupScreen } from './src/screens/SetupScreen';
import { AppProvider, useApp } from './src/state/AppState';
import { color, font } from './src/theme';
import { AppBackground } from './src/ui/AppBackground';

const Stack = createNativeStackNavigator<RootStackParamList>();

// Transparent surfaces everywhere so the app's single ground colour shows
// through every screen.
const navTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: 'transparent',
    card: 'transparent',
    border: color.lineSoft,
    text: color.ink,
    primary: color.brass,
    notification: color.coral,
  },
};

const screenOptions = {
  // Transparent like every other surface, so the stack header merges into the
  // black ground instead of sitting on it as a near-black bar. There is no
  // separator to lose: `headerShadowVisible` is already off.
  headerStyle: { backgroundColor: 'transparent' },
  headerTintColor: color.ink,
  headerTitleStyle: { fontFamily: font.display, fontSize: 16 },
  headerShadowVisible: false,
  contentStyle: { backgroundColor: 'transparent' },
} as const;

/** The eight-screen UI — the only one. */
function FullStack() {
  return (
    <Stack.Navigator screenOptions={screenOptions}>
      <Stack.Screen name="Inbox" component={InboxScreen} options={{ headerShown: false }} />
      <Stack.Screen name="Conversation" component={ConversationScreen} options={{ title: 'Conversation' }} />
      <Stack.Screen name="Message" component={MessageScreen} options={{ title: '' }} />
      <Stack.Screen
        name="Compose"
        component={ComposeScreen}
        options={{ title: 'New message', presentation: 'modal' }}
        initialParams={{}}
      />
      <Stack.Screen name="Drafts" component={DraftsScreen} options={{ title: 'Drafts' }} />
      <Stack.Screen name="Scheduled" component={ScheduledScreen} options={{ title: 'Scheduled' }} />
      <Stack.Screen name="Keys" component={KeysScreen} options={{ title: 'Keys' }} />
      <Stack.Screen name="Recovery" component={RecoveryScreen} options={{ title: 'Key recovery' }} />
    </Stack.Navigator>
  );
}

function Root() {
  const { booting, session, identity } = useApp();
  // Opened by a signed-in account with no key on this device, and closed by the
  // setup screen itself — not by `identity` becoming non-null, which happens
  // half way through and would unmount the screen before it has asked about
  // publishing.
  const [setupOpen, setSetupOpen] = useState(false);

  useEffect(() => {
    if (session && !identity) setSetupOpen(true);
  }, [identity, session]);

  if (booting) {
    return (
      <View style={{ alignItems: 'center', flex: 1, justifyContent: 'center' }}>
        <ActivityIndicator color={color.brass} />
      </View>
    );
  }

  if (!session) return <ConnectScreen />;
  if (setupOpen) return <SetupScreen onDone={() => setSetupOpen(false)} />;

  return (
    <NavigationContainer theme={navTheme}>
      <FullStack />
    </NavigationContainer>
  );
}

export default function App() {
  // Paint the web page canvas dark so any gutter/overscroll never flashes white.
  useEffect(() => {
    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      document.documentElement.style.backgroundColor = color.ground;
      document.body.style.backgroundColor = color.ground;
    }
  }, []);

  // Gate on the custom faces so text never flashes in a fallback and reflows.
  const [fontsLoaded] = useFonts({
    SpaceGrotesk_500Medium,
    SpaceGrotesk_700Bold,
    Manrope_400Regular,
    Manrope_500Medium,
    Manrope_600SemiBold,
    Manrope_700Bold,
    Manrope_800ExtraBold,
    JetBrainsMono_400Regular,
    JetBrainsMono_500Medium,
  });

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <AppProvider>
        <AppBackground>
          {fontsLoaded ? (
            <Root />
          ) : (
            <View style={{ alignItems: 'center', flex: 1, justifyContent: 'center' }}>
              <ActivityIndicator color={color.brass} />
            </View>
          )}
        </AppBackground>
      </AppProvider>
    </SafeAreaProvider>
  );
}
