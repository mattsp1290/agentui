import { SafeAreaView, ScrollView, StatusBar, StyleSheet, View } from 'react-native';
import { spacing } from '@agentui/theme';
import { useTheme } from '@agentui/theme/react';
import { Surface, Text, ThemeProvider } from '@agentui/ui-primitives/native';

export default function App() {
  return (
    <ThemeProvider appearance="dark">
      <DisconnectedScreen />
    </ThemeProvider>
  );
}

function DisconnectedScreen() {
  const theme = useTheme();
  return (
    <SafeAreaView style={[styles.canvas, { backgroundColor: theme.colors.canvas }]}>
      <StatusBar barStyle={theme.appearance === 'dark' ? 'light-content' : 'dark-content'} />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <Text variant="title" accessibilityRole="header">AgentUI</Text>
          <Text variant="muted">Your agents, within reach.</Text>
        </View>
        <Surface style={styles.panel} testID="disconnected-screen">
          <Text variant="label" style={{ color: theme.colors.accent }}>Not connected</Text>
          <Text variant="title" accessibilityRole="header">A home for your conversations</Text>
          <Text>
            AgentUI connects to agents running on your Mac. Your agents and conversations stay on the host.
          </Text>
          <View style={[styles.divider, { backgroundColor: theme.colors.border }]} />
          <Text variant="label">This developer build</Text>
          <Text>
            The iOS app is installed and ready to open. Host connection and conversations are not available in this build yet.
          </Text>
        </Surface>
        <Text variant="muted">No host is connected. No credentials are stored.</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  canvas: { flex: 1 },
  content: { flexGrow: 1, justifyContent: 'center', padding: spacing.xl, gap: spacing.xxl },
  header: { gap: spacing.sm },
  panel: { gap: spacing.lg },
  divider: { height: 1, marginVertical: spacing.sm },
});
